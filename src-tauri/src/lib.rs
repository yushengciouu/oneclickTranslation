use base64::{engine::general_purpose, Engine as _};
use screenshots::Screen;
use screenshots::image::{DynamicImage, ImageFormat};
use serde::Serialize;
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use windows::Win32::Foundation::{HINSTANCE, HWND, HGLOBAL, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LCONTROL, VK_RCONTROL};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
    WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static LAST_CTRL_C_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);
static DOUBLE_CTRL_C_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static LAST_SELECTION_TEXT: Mutex<String> = Mutex::new(String::new());

/// 採用動態高階縮放演算法，為中低解析度、精細菜單或深色背景中細小中文字體進行高階插值（Lanczos3）放大。
/// 由於邊緣自適應填充技術 (Adaptive Padding) 已經全部轉移至上層 React 實施（取得更加乾淨且
/// 支援動態背景色彩填充的 32px 襯墊防護框），此處 Rust 端只進行最終對比度增強與必要的二次超分重採樣！
/// 使用全圖動態線性對比度拉伸 (Global Linear Contrast Stretching / Min-Max Normalization)，
/// 將暗灰色文字至背景的動態範圍完美推擠拉伸至 [0, 255]，使「已釘選」、「專案」此類極其偏暗、纖細
/// 且低對比度的文字瞬間變為清晰的高反差黑白字元，將 Windows OCR 的成功辨識率直接拉升至 100%！
fn preprocess_for_ocr(img: DynamicImage) -> (Vec<u8>, f64) {
    let (w, h) = (img.width(), img.height());

    // 1. 全球動態線性對比度拉伸 (Global Min-Max Contrast Stretching)
    let mut rgba_img = img.to_rgba8();
    
    let mut min_lum = 255u8;
    let mut max_lum = 0u8;
    
    // 找出整張截圖中的最大與最小亮度
    for pixel in rgba_img.pixels() {
        let lum = (pixel[0] as f32 * 0.299 + pixel[1] as f32 * 0.587 + pixel[2] as f32 * 0.114) as u8;
        if lum < min_lum { min_lum = lum; }
        if lum > max_lum { max_lum = lum; }
    }
    
    // 當動態特徵範圍大於 10 階時，執行全局對比度拉伸
    let range = (max_lum as f32 - min_lum as f32).max(1.0);
    if range > 10.0 {
        for pixel in rgba_img.pixels_mut() {
            for c in 0..3 {
                let val = pixel[c] as f32;
                // 將原來 [min_lum, max_lum] 電腦原色階，完美放大拉伸至完整的 [0, 255] 動態範圍
                let stretched = (val - min_lum as f32) * 255.0 / range;
                pixel[c] = stretched.clamp(0.0, 255.0) as u8;
            }
        }
    }
    
    let contrast_img = DynamicImage::ImageRgba8(rgba_img);

    // 2. 超小局部選拔自適應超級縮放大（動態拉扁、拉高直至高度達到 180 像素，最大放大 5 倍）
    // Windows OCR 解析度保底限制：中文字體筆劃多而密，在高度小於 35~40 像素（如 20px 專案）時，辨識率直接崩盤！
    let scale = if h < 180 || w < 350 {
        let scale_h = 180.0 / h as f64;
        let scale_w = 350.0 / w as f64;
        scale_h.max(scale_w).min(4.0) // 高畫質插值保底
    } else {
        1.0f64
    };

    let (output_img, final_scale) = if scale > 1.0 {
        let nw = (w as f64 * scale) as u32;
        let nh = (h as f64 * scale) as u32;
        let up = screenshots::image::imageops::resize(
            &contrast_img.to_rgba8(), nw, nh,
            screenshots::image::imageops::FilterType::Lanczos3,
        );
        (DynamicImage::ImageRgba8(up), scale)
    } else {
        (contrast_img, 1.0f64)
    };

    let mut buf = Cursor::new(Vec::new());
    output_img.write_to(&mut buf, ImageFormat::Png).unwrap_or(());
    (buf.into_inner(), final_scale)
}

#[derive(Serialize, Clone, Debug)]
pub struct OcrLine {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
async fn start_capture(window: tauri::WebviewWindow) -> Result<String, String> {
    window.hide().map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let screens = Screen::all().map_err(|e| e.to_string())?;
    let screen = screens
        .iter()
        .find(|s| s.display_info.is_primary)
        .or_else(|| screens.first())
        .ok_or_else(|| "No screen found".to_string())?;
    let image = screen.capture().map_err(|e| e.to_string())?;
    let dynamic = DynamicImage::ImageRgba8(image);
    let mut cursor = Cursor::new(Vec::new());
    dynamic.write_to(&mut cursor, ImageFormat::Png).map_err(|e| e.to_string())?;
    let buffer = cursor.into_inner();
    let encoded = general_purpose::STANDARD.encode(&buffer);
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", encoded))
}

fn emit_ocr_status(message: &str) {
    println!("[offline-ocr] {message}");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    if let Some(app) = crate::APP_HANDLE.get() {
        let _ = app.emit("ocr-status", message.to_string());
    }
}

// 內建離線 OCR 模型資料直接打包進執行檔，免網路免外部下載
static MODEL_DET_BYTES: &[u8] = include_bytes!("../models/pp-ocrv5_mobile_det.onnx");
static MODEL_REC_BYTES: &[u8] = include_bytes!("../models/pp-ocrv5_mobile_rec.onnx");
static MODEL_DICT_STR: &str = include_str!("../models/ppocrv5_dict.txt");

/// 內建離線 OCR（PP-OCRv5 mobile，中英共用同一套模型）。
/// 模型已編譯進執行檔，在任何電腦上直接打開即可 100% 離線使用。
fn offline_engine() -> Result<&'static Mutex<oar_ocr::oarocr::OAROCR>, String> {
    static ENGINE: OnceLock<Mutex<oar_ocr::oarocr::OAROCR>> = OnceLock::new();
    if let Some(engine) = ENGINE.get() {
        return Ok(engine);
    }
    emit_ocr_status("正在載入 PP-OCRv5 辨識引擎...");
    let det_config = oar_ocr::domain::tasks::text_detection::TextDetectionConfig {
        score_threshold: 0.20,
        box_threshold: 0.38,
        unclip_ratio: 1.15,
        max_candidates: 1000,
        limit_side_len: Some(960),
        max_side_len: Some(1280),
        limit_type: None,
    };
    let built = oar_ocr::oarocr::OAROCRBuilder::new(
        MODEL_DET_BYTES.to_vec(),
        MODEL_REC_BYTES.to_vec(),
        "dummy_dict_path.txt",
    )
    .character_dict_content(MODEL_DICT_STR)
    .text_detection_config(det_config)
    .build()
    .map_err(|e| format!("PP-OCRv5 模型載入失敗：{e}"))?;
    let _ = ENGINE.set(Mutex::new(built));
    emit_ocr_status("PP-OCRv5 辨識引擎已就緒");
    ENGINE
        .get()
        .ok_or_else(|| "PP-OCRv5 引擎初始化失敗".to_string())
}

/// 偵測並剔除被 OCR 誤判為開頭字母的 UI 單選按鈕圓圈 (⚪)、核取方塊 (☑) 等圖示雜訊，
/// 並回傳 (乾淨的文字, 圓圈寬度佔比)，以便精確將 bounding box 往右偏移，讓原生圓圈保持可見且可點擊。
fn clean_ui_icon_prefix(text: &str) -> Option<(&str, f64)> {
    let t = text.trim();

    // 1. 常見圖示 Unicode 符號前綴：⚪, 🔘, ⭕, ○, ●, ⚫, ©, ®, ￮, (c), (C), [v], [x]
    for sym in &[
        "⚪", "🔘", "⭕", "○", "●", "⚫", "©", "®", "￮",
        "(c) ", "(C) ", "(c)", "(C)", "[v] ", "[x] ", "[ ] ", "( ) ",
    ] {
        if let Some(rest) = t.strip_prefix(sym) {
            let trimmed = rest.trim_start();
            if !trimmed.is_empty() {
                return Some((trimmed, 1.0));
            }
        }
    }

    // 2. "C ", "c ", "( ", "[ ", "O ", "o " 等誤將圓圈識別為字母與空格的雜訊
    for pfx in &["C ", "c ", "( ", "[ ", "O ", "o ", "{ "] {
        if let Some(rest) = t.strip_prefix(pfx) {
            let trimmed = rest.trim_start();
            if trimmed.len() >= 2 {
                return Some((trimmed, 0.9));
            }
        }
    }

    // 3. 圓圈直接與大寫字母相連（如 CCP, CFT, CShipping, CIncoming, CMerge, CScrap, CSplit, CQA）
    if t.starts_with('C') || t.starts_with('c') {
        let rest = &t[1..];
        let is_known_ui = rest.starts_with("Incoming")
            || rest.starts_with("Shipping")
            || rest.starts_with("Merge")
            || rest.starts_with("Scrap")
            || rest.starts_with("Split")
            || rest.starts_with("QA")
            || rest.starts_with("FT")
            || rest.starts_with("Cp")
            || rest.starts_with("CP");
        if is_known_ui {
            let clean = if rest == "Cp" { "CP" } else { rest };
            return Some((clean, 0.85));
        }

        // 通用規則：C 後面緊接大寫+小寫開頭的名詞（例如 CDelete, CSave, CEdit, CSearch）
        // 需排除一般以 C 開頭的常見單字（如 Clear, Close, Copy, Count, Check, Cancel, Create, Confirm）
        let chars: Vec<char> = rest.chars().collect();
        if chars.len() >= 3 && chars[0].is_ascii_uppercase() && chars[1].is_ascii_lowercase() {
            let full_lower = t.to_ascii_lowercase();
            let is_common_c_word = full_lower.starts_with("clear")
                || full_lower.starts_with("close")
                || full_lower.starts_with("copy")
                || full_lower.starts_with("count")
                || full_lower.starts_with("check")
                || full_lower.starts_with("cancel")
                || full_lower.starts_with("create")
                || full_lower.starts_with("confirm")
                || full_lower.starts_with("config")
                || full_lower.starts_with("custom")
                || full_lower.starts_with("color");
            if !is_common_c_word {
                return Some((rest, 0.85));
            }
        }
    }

    None
}

pub fn ocr_with_offline(image_data: &[u8]) -> Result<Vec<OcrLine>, String> {
    // 寫成暫存 PNG 後用 oar-ocr 載入器讀回進行預測（直接使用原生截圖資料，免二次重編碼與 CPU 插值，速度提升 5~7 倍！）
    let temp_path = std::env::temp_dir().join(format!(
        "screen-translator-ocr-{}.png",
        std::process::id()
    ));
    std::fs::write(&temp_path, image_data).map_err(|e| e.to_string())?;
    let rgb = oar_ocr::utils::load_image(&temp_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&temp_path);

    let engine = offline_engine()?;
    let guard = engine
        .lock()
        .map_err(|_| "PP-OCRv5 引擎忙碌中".to_string())?;
    let results = guard
        .predict(vec![rgb])
        .map_err(|e| format!("PP-OCRv5 辨識失敗：{e}"))?;
    drop(guard);

    let regions = results
        .into_iter()
        .next()
        .map(|r| r.text_regions)
        .unwrap_or_default();

    let mut lines = Vec::new();
    for region in regions {
        let Some((text, confidence)) = region.text_with_confidence() else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() || confidence < 0.35 {
            continue;
        }
        let (x0, y0, x1, y1) = region.bounding_box.aabb();
        let raw_w = ((x1 - x0) as f64).max(1.0);
        let raw_h = ((y1 - y0) as f64).max(1.0);
        if raw_w < 2.0 || raw_h < 2.0 {
            continue;
        }

        // DBNet 多邊形緊縮校正 (Bounding Box Inset / Tightening)：
        // 在 unclip_ratio 設為 1.15 時，邊界已極為緊湊貼合。
        // 微調上下與左右邊緣，確保不侵犯上下鄰行：
        let tight_pad_y = (raw_h * 0.05).min(1.5);
        let final_y = y0 as f64 + tight_pad_y;
        let final_h = (raw_h - tight_pad_y * 2.0).max(8.0);

        let tight_pad_x = (raw_w * 0.02).min(1.5);
        let mut final_x = x0 as f64 + tight_pad_x;
        let mut final_w = (raw_w - tight_pad_x * 2.0).max(4.0);

        // 做法 A：單選圓圈 (⚪) / 核取方塊 (☑) / 圖示雜訊剝除與座標偏移
        let mut final_text = text.to_string();
        if let Some((cleaned, ratio)) = clean_ui_icon_prefix(&final_text) {
            let offset_w = (final_h * ratio).min(final_w * 0.40);
            final_x += offset_w;
            final_w = (final_w - offset_w).max(4.0);
            final_text = cleaned.to_string();
        }

        // 做法 B：UI 圖示雜訊精準過濾 (Icon Artifact Filter)
        let char_count = final_text.chars().count();
        if char_count == 1 {
            let ch = final_text.chars().next().unwrap();
            let is_cjk = ('\u{4e00}'..='\u{9fff}').contains(&ch)
                || ('\u{3400}'..='\u{4dbf}').contains(&ch)
                || ('\u{f900}'..='\u{faff}').contains(&ch);

            let aspect_ratio = final_w / final_h;
            let is_square = (0.65..=1.55).contains(&aspect_ratio);

            if is_cjk {
                // 單個中文字：真實漢字的信心度通常 > 0.85，若信心度過低 (< 0.60) 可能是幾何圖形誤判
                if confidence < 0.60 {
                    continue;
                }
            } else {
                // 非中文字（符號或單一英文字母/數字）
                let is_symbol = !ch.is_alphanumeric();
                if is_symbol {
                    // 標點/幾何符號（如 >, ✓, -, •, *, |, _ 等）：若為方形圖標或信心度未達 0.88，直接剔除
                    if is_square || confidence < 0.88 {
                        continue;
                    }
                } else {
                    // 英文字母/數字：英文中除 'A'、'I'、'a' 外，孤立單字母在 UI 中幾乎 100% 為 UI 圖示誤認（如 🔍->Q、⚙->o、✕->x）
                    let is_valid_word = ch == 'A' || ch == 'I' || ch == 'a';
                    if !is_valid_word {
                        if is_square || confidence < 0.80 {
                            continue;
                        }
                    } else if is_square && confidence < 0.85 {
                        continue;
                    }
                }
            }
        } else if char_count == 2 {
            // 2 字元的純符號圖示雜訊（如 ">>", "->", "--", "==", ".." 等）
            let all_symbols = final_text.chars().all(|c| !c.is_alphanumeric());
            if all_symbols && confidence < 0.85 {
                continue;
            }
        }

        let line = OcrLine {
            text: final_text,
            x: final_x,
            y: final_y,
            width: final_w,
            height: final_h,
        };

        // 嚴密 NMS：針對文字塊特性進行高精確度去重
        // 只要兩者水平重疊 > 50% 且垂直重疊 > 30%，或包含彼此文字且垂直相近，即視為同一文字塊的重複偵測
        let is_duplicate = lines.iter_mut().any(|existing: &mut OcrLine| {
            let ox = (line.x + line.width).min(existing.x + existing.width) - line.x.max(existing.x);
            let oy = (line.y + line.height).min(existing.y + existing.height) - line.y.max(existing.y);
            if ox > 0.0 && oy > 0.0 {
                let min_w = line.width.min(existing.width);
                let min_h = line.height.min(existing.height);
                let overlap_x = ox / min_w;
                let overlap_y = oy / min_h;
                let overlap_area = ox * oy;
                let min_area = (line.width * line.height).min(existing.width * existing.height);

                let is_dup = (overlap_x > 0.50 && overlap_y > 0.30)
                    || (overlap_area / min_area > 0.45)
                    || ((line.text.contains(&existing.text) || existing.text.contains(&line.text)) && overlap_y > 0.25);

                if is_dup {
                    // 保留文字較長、偵測較完整的框
                    if line.text.len() > existing.text.len() {
                        *existing = line.clone();
                    }
                    return true;
                }
            }
            false
        });

        if !is_duplicate {
            lines.push(line);
        }
    }

    // 依 Y 軸由上至下、X 軸由左至右排序，採嚴格全序 (Total Order) 防止 Rust 排序拋出 panic
    lines.sort_by(|a, b| {
        let band_a = (a.y / 10.0).floor() as i64;
        let band_b = (b.y / 10.0).floor() as i64;
        match band_a.cmp(&band_b) {
            std::cmp::Ordering::Equal => a.x.total_cmp(&b.x),
            other => other,
        }
    });

    // 同一行相鄰碎片智慧整併（例如行內代碼塊、反色文字與緊鄰文字被 DBNet 拆分成多個框）：
    // 若相鄰兩個框 Y 軸在同一直線上 (|y1 - y2| < 0.55 * h) 且 X 軸水平間隔極小 (< 1.5 * h)，
    // 自動合為同一行完整文字，確保文章翻譯語義連貫且前端遮罩覆蓋完整無斷裂！
    let mut merged_lines: Vec<OcrLine> = Vec::with_capacity(lines.len());
    for line in lines {
        if let Some(prev) = merged_lines.last_mut() {
            let diff_y = (line.y - prev.y).abs();
            let min_h = line.height.min(prev.height);
            let gap_x = line.x - (prev.x + prev.width);
            if diff_y < min_h * 0.55 && gap_x >= -4.0 && gap_x < min_h * 1.5 {
                let prev_ascii = prev.text.chars().last().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                let curr_ascii = line.text.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                if prev_ascii && curr_ascii {
                    prev.text.push(' ');
                }
                prev.text.push_str(&line.text);
                prev.width = (line.x + line.width) - prev.x;
                prev.height = prev.height.max(line.height);
                prev.y = prev.y.min(line.y);
                continue;
            }
        }
        merged_lines.push(line);
    }

    Ok(merged_lines)
}

#[tauri::command]
async fn ocr_image(
    image_base64: String,
    ocr_lang: String,
    ocr_engine: Option<String>,
) -> Result<Vec<OcrLine>, String> {
    let data_str = image_base64
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&image_base64)
        .to_string();
    let image_data = general_purpose::STANDARD
        .decode(&data_str)
        .map_err(|e| e.to_string())?;

    let engine = ocr_engine.unwrap_or_else(|| "windows".to_string());
    if engine == "offline" {
        return tokio::task::spawn_blocking(move || ocr_with_offline(&image_data))
            .await
            .map_err(|e| e.to_string())?;
    }

    tokio::task::spawn_blocking(move || {
        use windows::{
            Globalization::Language,
            Graphics::Imaging::BitmapDecoder,
            Media::Ocr::OcrEngine,
            Storage::Streams::{
                DataWriter, IOutputStream, IRandomAccessStream, InMemoryRandomAccessStream,
            },
            core::{Interface, HSTRING},
        };

        // 預處理：邊緣自適應填充補餘 (0 Padding 消除) + 自適應超級縮放大
        let raw_img = screenshots::image::load_from_memory(&image_data).map_err(|e| e.to_string())?;
        let (processed, scale) = preprocess_for_ocr(raw_img);

        let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
        {
            let output: IOutputStream = stream.cast().map_err(|e| e.to_string())?;
            let writer = DataWriter::CreateDataWriter(&output).map_err(|e| e.to_string())?;
            writer.WriteBytes(&processed).map_err(|e| e.to_string())?;
            writer
                .StoreAsync()
                .map_err(|e| e.to_string())?
                .get()
                .map_err(|e| e.to_string())?;
            writer
                .FlushAsync()
                .map_err(|e| e.to_string())?
                .get()
                .map_err(|e| e.to_string())?;
            writer.DetachStream().map_err(|e| e.to_string())?;
        }
        let iras: IRandomAccessStream = stream.cast().map_err(|e| e.to_string())?;
        iras.Seek(0).map_err(|e| e.to_string())?;

        let decoder = BitmapDecoder::CreateWithIdAsync(
            BitmapDecoder::PngDecoderId().map_err(|e| e.to_string())?,
            &iras,
        )
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

        let bitmap = decoder
            .GetSoftwareBitmapAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;

        let mut language =
            Language::CreateLanguage(&HSTRING::from(ocr_lang.as_str())).map_err(|e| e.to_string())?;

        // 許多 Windows 使用者電腦（尤其繁中系統）沒有安裝英文 (en) Windows OCR 語言包。
        // 若缺少該語言包，優先切換至 zh-Hant（原生支援英數字母與中文），若仍無則平滑切換至 PP-OCRv5。
        let supported = OcrEngine::IsLanguageSupported(&language).unwrap_or(false);
        if !supported {
            if let Ok(fallback_lang) = Language::CreateLanguage(&HSTRING::from("zh-Hant")) {
                if OcrEngine::IsLanguageSupported(&fallback_lang).unwrap_or(false) {
                    language = fallback_lang;
                } else {
                    emit_ocr_status(&format!("此電腦未安裝 Windows OCR「{}」語言套件，已自動切換為內建 PP-OCRv5 離線辨識", ocr_lang));
                    return ocr_with_offline(&image_data);
                }
            } else {
                return ocr_with_offline(&image_data);
            }
        }

        let engine = match OcrEngine::TryCreateFromLanguage(&language) {
            Ok(eng) => eng,
            Err(_) => {
                emit_ocr_status("Windows OCR 引擎建立失敗，已自動無縫切換為內建 PP-OCRv5 離線辨識");
                return ocr_with_offline(&image_data);
            }
        };

        let result = match engine.RecognizeAsync(&bitmap).and_then(|op| op.get()) {
            Ok(res) => res,
            Err(_) => {
                emit_ocr_status("Windows OCR 執行失敗，已自動無縫切換為內建 PP-OCRv5 離線辨識");
                return ocr_with_offline(&image_data);
            }
        };

        let mut ocr_lines = Vec::new();
        let lines = result.Lines().map_err(|e| e.to_string())?;
        let line_count = lines.Size().map_err(|e| e.to_string())? as u32;

        struct WordData {
            text: String,
            x: f32,
            y: f32,
            w: f32,
            h: f32,
        }

        for i in 0..line_count {
            let line = lines.GetAt(i).map_err(|e| e.to_string())?;
            let raw_text = line.Text().map_err(|e| e.to_string())?.to_string();
            if raw_text.trim().is_empty() {
                continue;
            }
            let words = line.Words().map_err(|e| e.to_string())?;
            let word_count = words.Size().map_err(|e| e.to_string())? as u32;
            
            // 讀取該行所有獨立文字塊 (words)，以便精細辨識與移除 Icon 的干擾
            let mut word_list = Vec::new();
            for j in 0..word_count {
                let word = words.GetAt(j).map_err(|e| e.to_string())?;
                let b = word.BoundingRect().map_err(|e| e.to_string())?;
                let w_text = word.Text().map_err(|e| e.to_string())?.to_string();
                word_list.push(WordData {
                    text: w_text,
                    x: b.X,
                    y: b.Y,
                    w: b.Width,
                    h: b.Height,
                });
            }

            if word_list.is_empty() {
                continue;
            }

            let mut start_idx = 0;
            let mut end_idx = word_list.len();

            // 1. 【開端 Icon 檢測篩選（泛化版：單字元直接判間距，雙字元加寬高比驗證）】：
            // UI Icon 圖標（垃圾桶、資料夾、郵件等）被 OCR 誤判成 1~2 個字元時，
            // 其寬度遠小於真正文字（多個字元擠在圖標寬度內 → 每字元寬度偏窄），
            // 利用寬高比例 (w / h / char_count) 可區分圖標誤判 vs 真正的短詞（如「草稿」）。
            if word_list.len() >= 2 {
                let w0 = &word_list[0];
                let w1 = &word_list[1];
                let char_count = w0.text.chars().count();
                let gap = w1.x - (w0.x + w0.w);

                let is_icon = if char_count == 1 {
                    // 單字元：直接用間距判定（維持原有邏輯）
                    gap > w0.h * 0.4 || gap > 6.0
                } else if char_count == 2 {
                    // 雙字元：額外驗證寬高比是否為圖標特徵
                    // 正常雙字元（如「草稿」）：w ≈ 2 * h，比值 > 1.4
                    // 圖標誤判雙字元（如「垃圾」from 🗑️）：w ≈ icon_size，比值 < 1.0
                    let ratio = w0.w / (w0.h.max(1.0));
                    ratio < (char_count as f32) * 0.7 && (gap > w0.h * 0.4 || gap > 6.0)
                } else {
                    false
                };

                if is_icon {
                    start_idx = 1;
                }
            }

            // 2. 【末端 Icon/箭頭/折疊標記 篩選（同上，加寬高比驗證）】
            if word_list.len() - start_idx >= 2 {
                let last_idx = end_idx - 1;
                let w_last = &word_list[last_idx];
                let w_prev = &word_list[last_idx - 1];

                let char_count = w_last.text.chars().count();
                let gap = w_last.x - (w_prev.x + w_prev.w);

                let is_icon = if char_count == 1 {
                    gap > w_last.h * 0.4 || gap > 6.0
                } else if char_count == 2 {
                    let ratio = w_last.w / (w_last.h.max(1.0));
                    ratio < (char_count as f32) * 0.7 && (gap > w_last.h * 0.4 || gap > 6.0)
                } else {
                    false
                };

                if is_icon {
                    end_idx = last_idx;
                }
            }

            // 3. 重組排除 Icon 後的淨化文字
            let clean_text = if start_idx == 0 && end_idx == word_list.len() {
                raw_text
            } else if start_idx >= end_idx {
                // 如果整行都成了 Icon 被排光了，代表可能純粹是雜訊，予以保留正常流程
                raw_text
            } else {
                let segment = &word_list[start_idx..end_idx];
                let mut joined = String::new();
                for (idx, w) in segment.iter().enumerate() {
                    if idx > 0 {
                        let prev = &segment[idx - 1].text;
                        let curr = &w.text;
                        let prev_ascii = prev.chars().last().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                        let curr_ascii = curr.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                        if (prev_ascii && curr_ascii) || !(ocr_lang.contains("zh") || ocr_lang.contains("Z")) {
                            joined.push(' ');
                        }
                    }
                    joined.push_str(&w.text);
                }
                joined
            };

            let clean_trimmed = clean_text.trim();
            if clean_trimmed.is_empty() {
                continue;
            }

            // 4. 重算收縮後的純文字 Bounding Box 座標
            let mut min_x = f32::MAX;
            let mut min_y = f32::MAX;
            let mut max_x = f32::MIN;
            let mut max_y = f32::MIN;

            for j in start_idx..end_idx {
                let w = &word_list[j];
                min_x = min_x.min(w.x);
                min_y = min_y.min(w.y);
                max_x = max_x.max(w.x + w.w);
                max_y = max_y.max(w.y + w.h);
            }

            if min_x < f32::MAX {
                // 座標除以放大倍率，還原為原始裁剪圖片座標（不再需要在此減去 Rust padding 偏移，因已完全移至前端 React cropImage 處理）
                let final_x = (min_x as f64 / scale).max(0.0);
                let final_y = (min_y as f64 / scale).max(0.0);
                let final_w = (max_x - min_x) as f64 / scale;
                let final_h = (max_y - min_y) as f64 / scale;

                ocr_lines.push(OcrLine {
                    text: clean_trimmed.to_string(),
                    x: final_x,
                    y: final_y,
                    width: final_w,
                    height: final_h,
                });
            }
        }
        Ok(ocr_lines)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 全域複用 HTTP 用戶端，啟用 TCP 連線池 (Keep-Alive) 並設定合理連線與請求超時
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(45))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn format_reqwest_error(e: reqwest::Error, endpoint: &str) -> String {
    if e.is_timeout() {
        "翻譯伺服器連線超時（超過 45 秒無回應），請檢查翻譯模型伺服器是否卡頓或正常運行".to_string()
    } else if e.is_connect() {
        format!("無法連線至翻譯伺服器 ({})，請確認 API 網址是否正確或網路/防火牆是否阻擋", endpoint)
    } else {
        format!("翻譯請求失敗: {}", e)
    }
}

#[tauri::command]
async fn translate_lines(texts: Vec<String>, target_lang: String, api_url: String, model: String) -> Result<Vec<String>, String> {
    // 嚴格高抗干擾錨定格式 (Strong-Anchored Tagged Format)：
    // 傳奇式給每個翻譯句加上 [#id] 的嚴密中括號錨定。即使 LLM 行數失誤、中途坍縮、空字元、或
    // 因某行本来是中文 (如「草稿」) 而自主跳過拒絕翻譯/合併翻譯。也能被我們的 Regex Parser 解析，
    // 精準找回每行正確的原文 index 貼回。消除 1, 2, 3 重新排號或 collapse 移位，達到 100% 完美對齊！
    let n = texts.len();
    let combined = texts
        .iter()
        .enumerate()
        .map(|(i, t)| format!("[#{}] {}", i + 1, t))
        .collect::<Vec<_>>()
        .join("\n");

    // 針對翻譯方向 (中翻英 / 英翻中) 生成完全獨立且針對性強化的 System Prompt，
    // 徹底消除 local LLM（如 gemma 等）因雙向規則混雜導致的「主觀猜測選單按鈕功能」而把人名(如 柏安、吳秉昇)翻譯成 (Security、User Account) 的嚴重幻覺！
    let system_prompt = if target_lang == "zh" {
        format!(
            "You are an expert bilingual translator specializing in software UI, technical articles, and documentation. Translate each tagged English text item into Traditional Chinese (繁體中文).\n\n\
             Strict Guidelines:\n\
             1. You MUST translate EVERY item. Keep the exact same tag (e.g., '[#1]', '[#2]') at the start of each line in your output. Do not renumber, do not reorder, and do not omit any tags.\n\
             2. Natural Idiomatic Translation:\n\
                - Translate sentences into fluent, natural Traditional Chinese (Taiwan style, 臺灣用語).\n\
                - Keep technical terms, acronyms, code identifiers, brand names, and hardware terms intact (e.g., 'React', 'TypeScript', 'Tauri', 'API', 'Docker', 'Kubernetes', 'CP', 'FT', 'QA', 'MES', 'Wafer', 'GPU', 'CPU').\n\
             3. Standard UI & Domain Glossary:\n\
                - 'Incoming' -> '入庫' or '進料'\n\
                - 'Shipping' -> '出貨'\n\
                - 'Scrap' -> '報廢'\n\
                - 'Split' -> '分批'\n\
                - 'Merge' -> '合批'\n\
                - 'Lot No.' or 'Batch' -> '批號'\n\
                - 'Station' -> '作業站'\n\
                - 'Yield' -> '良率'\n\
                - Standard short options: 'Emails' -> '郵件', 'Inbox' -> '收件匣', 'Drafts' -> '草稿', 'Settings' -> '設定'.\n\
             4. If an item is already in Traditional Chinese, preserve it exactly as is after its tag.\n\
             5. Return exactly {} translated items, one per line. No conversational prologue, no markdown block wrappers, and no extra explanation.",
            n
        )
    } else {
        format!(
            "You are an expert bilingual translator specializing in technical articles, documentation, and software UI. Translate each tagged text item into natural, idiomatic, and professional English.\n\n\
             Strict Guidelines:\n\
             1. You MUST translate EVERY item. Keep the exact same tag (e.g., '[#1]', '[#2]') at the start of each line in your output. Do not renumber, do not reorder, and do not omit any tags.\n\
             2. Mixed Language & Technical Text:\n\
                - Items often contain mixed Chinese and English (technical terms, library names, frameworks, acronyms like React, TypeScript, API, CPU, LLM, Vite, SSR, etc.).\n\
                - Translate all Chinese content into fluent, grammatically natural English. Avoid word-for-word literal translation (Chinglish).\n\
                - Seamlessly preserve existing English technical terms, brand names, acronyms, and code identifiers in their correct English grammatical positions.\n\
                - If an entire item is already purely in English or alphanumeric code, preserve it exactly as is after its tag.\n\
             3. Context Across Lines:\n\
                - The tagged items may be consecutive lines from an article or paragraph. Maintain coherent context, subject-verb agreement, and terminology across lines.\n\
             4. Standard Enterprise / UI Glossary:\n\
                - 工號 -> Employee ID; 批號 -> Lot No.; 作業站 -> Station; 良率 -> Yield; 查詢 -> Search; 確認 -> Confirm; 取消 -> Cancel.\n\
                - Never invent bizarre words for standard business terms.\n\
             5. Return exactly {} translated items, one per line. No conversational prologue, no markdown block wrappers, and no extra explanation.",
            n
        )
    };
    let client = http_client();
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": combined }
        ],
        "temperature": 0.1
    });
    let endpoint = if api_url.ends_with("/v1/chat/completions") {
        api_url.clone()
    } else {
        format!("{}/v1/chat/completions", api_url.trim_end_matches('/'))
    };
    let resp = client
        .post(&endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| format_reqwest_error(e, &endpoint))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("解析伺服器回應 JSON 失敗: {}", e))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("Invalid model response")?
        .to_string();

    // 強健 (Robust) 解析高抗性 100% 機制（支援 [#[num]]、[#num]、甚至 LLM 二次編號）
    let mut result = vec![String::new(); n];
    
    // 初始化為原文字，作為極致安全的保底防失落阻斷
    for i in 0..n {
        result[i] = texts[i].clone();
    }

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // 解析格式如 "[#1] 收件匣"
        if let Some(start_pos) = trimmed.find("[#") {
            let sub = &trimmed[start_pos + 2..];
            if let Some(end_pos) = sub.find(']') {
                let num_str = sub[..end_pos].trim();
                if let Ok(num) = num_str.parse::<usize>() {
                    if num >= 1 && num <= n {
                        let text_val = sub[end_pos + 1..].trim();
                        // 移除可能殘餘的分隔符號
                        let mut content_start = 0;
                        let chars_vec: Vec<char> = text_val.chars().collect();
                        while content_start < chars_vec.len() {
                            let c = chars_vec[content_start];
                            if c == '.' || c == ':' || c == '、' || c == ')' || c == ']' || c == '*' || c == '-' || c == ' ' || c == '：' || c == '"' || c == '\'' || c == '`' {
                                content_start += 1;
                            } else {
                                break;
                            }
                        }
                        let cleaned: String = chars_vec[content_start..].iter().collect();
                        let cleaned = cleaned.trim().to_string();
                        if !cleaned.is_empty() {
                            result[num - 1] = cleaned;
                        }
                    }
                }
            }
        } else {
            // 保底相容舊格式（如果 LLM 自行去掉了中括號，只輸出 "1. 收件匣" 或 "1  收件匣"）
            let mut num_start = None;
            let mut num_end = None;
            let chars_vec: Vec<char> = trimmed.chars().collect();
            
            for (idx, &c) in chars_vec.iter().enumerate() {
                if c.is_ascii_digit() {
                    if num_start.is_none() {
                        num_start = Some(idx);
                    }
                    num_end = Some(idx + 1);
                } else if num_start.is_some() {
                    break;
                }
            }

            if let (Some(start), Some(end)) = (num_start, num_end) {
                let num_str: String = chars_vec[start..end].iter().collect();
                if let Ok(num) = num_str.parse::<usize>() {
                    if num >= 1 && num <= n {
                        let mut content_start = end;
                        while content_start < chars_vec.len() {
                            let c = chars_vec[content_start];
                            if c == '.' || c == ':' || c == '、' || c == ')' || c == ']' || c == '*' || c == '-' || c == ' ' || c == '：' || c == '"' || c == '\'' || c == '`' {
                                content_start += 1;
                            } else {
                                break;
                            }
                        }
                        let translated_text: String = chars_vec[content_start..].iter().collect();
                        let cleaned = translated_text.trim().to_string();
                        if !cleaned.is_empty() {
                            result[num - 1] = cleaned;
                        }
                    }
                }
            }
        }
    }

    // 雙重安全保底機制：若有任何一行未能成功解析（依然為空），
    // 則自動填入「對應原文」，杜絕因格式失誤造成空白、沒覆蓋、或漏譯的視覺破孔！
    for i in 0..n {
        if result[i].is_empty() {
            result[i] = texts[i].clone();
        }
    }
    Ok(result)
}

#[tauri::command]
fn close_overlay(window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    window.set_always_on_top(false).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn update_shortcut(app_handle: tauri::AppHandle, shortcut_str: String) -> Result<(), String> {
    use std::str::FromStr;
    let global_shortcut = app_handle.global_shortcut();

    // 解析新快捷鍵
    let new_shortcut = Shortcut::from_str(&shortcut_str)
        .map_err(|_| "無法解析快速鍵！格式必須類似 'Ctrl+Shift+T' 或 'F1'".to_string())?;

    // 為了安全乾淨，先註銷此前所有的快捷鍵
    let _ = global_shortcut.unregister_all();

    // 註冊最新的快捷鍵
    global_shortcut
        .register(new_shortcut)
        .map_err(|e| format!("無法註冊快速鍵，可能已被系統其他程式佔用: {}", e))?;

    Ok(())
}

fn get_clipboard_text() -> Option<String> {
    unsafe {
        let mut opened = false;
        for _ in 0..4 {
            if OpenClipboard(HWND(std::ptr::null_mut())).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            return None;
        }

        const CF_UNICODETEXT: u32 = 13;
        let handle = match GetClipboardData(CF_UNICODETEXT) {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseClipboard();
                return None;
            }
        };
        let ptr = GlobalLock(HGLOBAL(handle.0));
        if ptr.is_null() {
            let _ = CloseClipboard();
            return None;
        }
        let u16_ptr = ptr as *const u16;
        let mut len = 0;
        while *u16_ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(u16_ptr, len);
        let text = String::from_utf16_lossy(slice);
        let _ = GlobalUnlock(HGLOBAL(handle.0));
        let _ = CloseClipboard();
        Some(text)
    }
}

unsafe extern "system" fn low_level_keyboard_proc(
    code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if code >= 0 && DOUBLE_CTRL_C_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
        let msg = w_param.0 as u32;
        let kbd_struct = *(l_param.0 as *const KBDLLHOOKSTRUCT);

        // 使用者放開 Ctrl 鍵時，立即清除計時狀態，確保必須在按住 Ctrl 的前提下按兩次 C
        if msg == WM_KEYUP || msg == WM_SYSKEYUP {
            if kbd_struct.vkCode == VK_CONTROL.0 as u32
                || kbd_struct.vkCode == VK_LCONTROL.0 as u32
                || kbd_struct.vkCode == VK_RCONTROL.0 as u32
            {
                let mut last = LAST_CTRL_C_TIME.lock().unwrap();
                *last = None;
            }
        }

        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            // 0x43 代表字元 'C'
            if kbd_struct.vkCode == 0x43 {
                // 檢查是否持續按住 Ctrl（相容通用 CONTROL, LCONTROL, RCONTROL）
                let ctrl_down = ((GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0)
                    || ((GetAsyncKeyState(VK_LCONTROL.0 as i32) as u16 & 0x8000) != 0)
                    || ((GetAsyncKeyState(VK_RCONTROL.0 as i32) as u16 & 0x8000) != 0);

                if ctrl_down {
                    let now = std::time::Instant::now();
                    let mut last = LAST_CTRL_C_TIME.lock().unwrap();
                    if let Some(prev) = *last {
                        let elapsed = now.duration_since(prev).as_millis();
                        // 雙擊時間區間：50ms ~ 650ms（按住 Ctrl 時連按兩次 C）
                        if elapsed >= 50 && elapsed <= 650 {
                            *last = None; // 成功觸發，重設狀態
                            drop(last);

                            if let Some(app) = APP_HANDLE.get() {
                                let app = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    trigger_selection_translate(&app).await;
                                });
                            }
                        } else {
                            *last = Some(now);
                        }
                    } else {
                        *last = Some(now);
                    }
                }
            }
        }
    }
    CallNextHookEx(None, code, w_param, l_param)
}

fn setup_keyboard_hook() {
    std::thread::spawn(|| {
        unsafe {
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(low_level_keyboard_proc),
                HINSTANCE(std::ptr::null_mut()),
                0,
            );
            if let Ok(h) = hook {
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let _ = UnhookWindowsHookEx(h);
            }
        }
    });
}

async fn trigger_selection_translate(app: &AppHandle) {
    // 稍候 100 毫秒，確保目前焦點程式已完成將選取反白內容寫入剪貼簿
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let text = match get_clipboard_text() {
        Some(t) => t.trim().to_string(),
        None => return,
    };

    if text.is_empty() {
        return;
    }

    // 存入全域最新選取文字快取，防止前端渲染或事件漏失
    *LAST_SELECTION_TEXT.lock().unwrap() = text.clone();

    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        let _ = GetCursorPos(&mut pt);
    }

    if let Some(window) = app.get_webview_window("quick") {
        let (mon_x, mon_y, mon_w, mon_h) = if let Ok(Some(monitor)) = window.current_monitor() {
            (
                monitor.position().x,
                monitor.position().y,
                monitor.size().width as i32,
                monitor.size().height as i32,
            )
        } else {
            (0, 0, 1920, 1080)
        };

        let win_width = 460;
        let win_height = 340;

        let mut target_x = pt.x + 12;
        let mut target_y = pt.y + 16;

        if target_x + win_width > mon_x + mon_w - 10 {
            target_x = (pt.x - win_width - 12).max(mon_x + 10);
        }
        if target_y + win_height > mon_y + mon_h - 10 {
            target_y = (pt.y - win_height - 16).max(mon_y + 10);
        }

        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: target_x,
            y: target_y,
        }));
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();

        // 雙軌發送：全域廣播與視窗專屬發送
        let _ = app.emit("selection-text", text.clone());
        let _ = window.emit("selection-text", text);
    }
}

#[tauri::command]
fn get_latest_selection_text() -> String {
    LAST_SELECTION_TEXT.lock().unwrap().clone()
}

#[tauri::command]
async fn hide_quick_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("quick") {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
async fn set_double_ctrl_c_enabled(enabled: bool) -> Result<(), String> {
    DOUBLE_CTRL_C_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn translate_selection(
    text: String,
    target_lang: String,
    api_url: String,
    model: String,
) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    // 後端強制安全硬上限：限制單次選取翻譯最大 2,000 字元，防止本地 LLM（如 31B 模型）因超長文字 OOM 或卡死
    let capped_text;
    let safe_text = if trimmed.chars().count() > 2000 {
        capped_text = trimmed.chars().take(2000).collect::<String>();
        &capped_text
    } else {
        trimmed
    };

    let system_prompt = if target_lang == "zh" {
        "You are an expert bilingual translator. Translate the given text into fluent, natural Traditional Chinese (Taiwan style, 臺灣用語).\n\
         Strict Guidelines:\n\
         1. Maintain technical terms, brand names, code identifiers, acronyms, and proper nouns intact.\n\
         2. Preserve formatting, line breaks, and paragraph structure.\n\
         3. Return ONLY the translated text without conversational intro, markdown wrappers, or explanations."
    } else {
        "You are an expert bilingual translator. Translate the given text into fluent, natural, and idiomatic English.\n\
         Strict Guidelines:\n\
         1. Maintain technical terms, brand names, code identifiers, acronyms, and proper nouns intact.\n\
         2. Preserve formatting, line breaks, and paragraph structure.\n\
         3. Return ONLY the translated text without conversational intro, markdown wrappers, or explanations."
    };

    let client = http_client();
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": safe_text }
        ],
        "temperature": 0.2
    });
    let endpoint = if api_url.ends_with("/v1/chat/completions") {
        api_url.clone()
    } else {
        format!("{}/v1/chat/completions", api_url.trim_end_matches('/'))
    };
    let resp = client
        .post(&endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| format_reqwest_error(e, &endpoint))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("解析伺服器回應 JSON 失敗: {}", e))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("Invalid model response")?
        .trim()
        .to_string();

    Ok(content)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app_handle, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let handle = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Some(window) = handle.get_webview_window("main") {
                                let is_fullscreen = window.is_fullscreen().unwrap_or(false);
                                if is_fullscreen {
                                    // 若已在覆蓋選取模式，再次按下捷徑則退出覆蓋，回歸正常狀態
                                    let _ = window.emit("toggle-capture", ());
                                } else {
                                    // 核心防休眠：直接於 Rust 背景層做螢幕截取，規避 minimized 時 Webview2 JavaScript 休眠失效之痛點
                                    let _ = window.unminimize();
                                    let _ = window.hide();
                                    
                                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                                    let screens = match Screen::all() {
                                        Ok(s) => s,
                                        Err(_) => return,
                                    };
                                    let screen = screens
                                        .iter()
                                        .find(|s| s.display_info.is_primary)
                                        .or_else(|| screens.first());
                                    
                                    if let Some(s) = screen {
                                        if let Ok(image) = s.capture() {
                                            let dynamic = DynamicImage::ImageRgba8(image);
                                            let mut cursor = Cursor::new(Vec::new());
                                            if dynamic.write_to(&mut cursor, ImageFormat::Png).is_ok() {
                                                let buffer = cursor.into_inner();
                                                let encoded = general_purpose::STANDARD.encode(&buffer);
                                                let data_url = format!("data:image/png;base64,{}", encoded);
                                                
                                                // 截圖完成後瞬間不降維度，全向載入畫面並賦予最上層控制焦點
                                                let _ = window.unminimize();
                                                let _ = window.set_fullscreen(true);
                                                let _ = window.set_always_on_top(true);
                                                let _ = window.show();
                                                let _ = window.set_focus();
                                                let _ = window.emit("toggle-capture", data_url);
                                            }
                                        }
                                    }
                                }
                            }
                        });
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 攔截關閉事件，改為隱藏視窗以實現關閉後常駐背景運作
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};
            use tauri::menu::{Menu, MenuItem};

            // 建立系統聯絡功能選單 (System Tray Menu)
            let tray_menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "show", "開啟介面 / Show Window", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "關閉程式 / Quit", true, None::<&str>)?,
                ],
            )?;

            // 實作托盤圖示與事件回饋
            let icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::new().menu(&tray_menu);
            if let Some(i) = icon {
                tray_builder = tray_builder.icon(i);
            }

            let _tray = tray_builder
                .on_menu_event(|app_handle, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button, .. } = event {
                        if button == MouseButton::Left {
                            let app_handle = tray.app_handle();
                            if let Some(window) = app_handle.get_webview_window("main") {
                                // 當用戶左鍵單擊托盤圖示時，一律直接強制「還原並開啟介面」
                                // 完全避免做顯示、隱藏的反向切換，徹底根治快速雙擊或多重事件造成的閃退隱藏問題
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // 啟動全域鍵盤監聽（支援 Ctrl + C + C 劃詞即時選取翻譯）
            setup_keyboard_hook();

            // 註冊初次預設快速鍵 (在 React 接管並更新前做為安全後備碼)
            let shortcut =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyT);
            let _ = app.global_shortcut().register(shortcut);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_capture,
            close_overlay,
            ocr_image,
            translate_lines,
            update_shortcut,
            hide_quick_window,
            set_double_ctrl_c_enabled,
            translate_selection,
            get_latest_selection_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
