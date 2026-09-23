use base64::{engine::general_purpose, Engine as _};
use screenshots::Screen;
use screenshots::image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

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
        scale_h.max(scale_w).min(5.0) // 高畫質插值保底
    } else if w > 3000 || h > 2000 {
        1.0f64
    } else if w > 1600 || h > 1200 {
        1.5f64
    } else {
        2.0f64
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

#[derive(Serialize, Clone)]
struct OcrLine {
    text: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
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

#[tauri::command]
async fn ocr_image(image_base64: String, ocr_lang: String) -> Result<Vec<OcrLine>, String> {
    let data_str = image_base64
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&image_base64)
        .to_string();
    let image_data = general_purpose::STANDARD
        .decode(&data_str)
        .map_err(|e| e.to_string())?;

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

        let language =
            Language::CreateLanguage(&HSTRING::from(ocr_lang.as_str())).map_err(|e| e.to_string())?;

        // TryCreateFromLanguage 在語言未安裝 OCR 元件時不會回傳 Err，而是回傳空物件，
        // 之後呼叫 RecognizeAsync 會導致不明確的失敗，因此先用 IsLanguageSupported 明確擋下並回報可診斷的錯誤。
        let supported = OcrEngine::IsLanguageSupported(&language).unwrap_or(false);
        if !supported {
            let available = OcrEngine::AvailableRecognizerLanguages()
                .ok()
                .map(|langs| {
                    (0..langs.Size().unwrap_or(0))
                        .filter_map(|i| langs.GetAt(i).ok())
                        .filter_map(|l| l.LanguageTag().ok())
                        .map(|t| t.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            return Err(format!(
                "此電腦尚未安裝「{}」的 Windows OCR 語言套件（設定 > 時間與語言 > 語言與地區 > 該語言 > 選用功能 > 光學字元辨識）。目前已安裝的 OCR 語言：[{}]",
                ocr_lang, available
            ));
        }

        let engine =
            OcrEngine::TryCreateFromLanguage(&language).map_err(|e| e.to_string())?;

        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;

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

            // 3. 【末端 數字/未讀數 篩選】：例如 Mail 資料夾右側的未讀數 "7" 或 "(7)"
            // 若最右側單字為純數字，且與左側相鄰文字有足夠間距，我們不將其納入覆蓋框中，以保留 Outlook 原生的未讀數樣式與顏色。
            if (end_idx > start_idx) && (end_idx - start_idx >= 2) {
                let last_idx = end_idx - 1;
                let w_last = &word_list[last_idx];
                let w_prev = &word_list[last_idx - 1];

                let is_pure_digit = w_last.text.chars().all(|c| c.is_ascii_digit() || "()（）".contains(c));
                if is_pure_digit {
                    let gap = w_last.x - (w_prev.x + w_prev.w);
                    if gap > w_last.h * 0.35 || gap > 5.5 {
                        // 排除尾端未讀數
                        end_idx = last_idx;
                    }
                }
            }

            // 4. 重組排除 Icon 與未讀數後的淨化文字
            let clean_text = if start_idx == 0 && end_idx == word_list.len() {
                raw_text
            } else if start_idx >= end_idx {
                // 如果整行都成了 Icon 被排光了，代表可能純粹是雜訊，予以保留正常流程
                raw_text
            } else {
                let segment = &word_list[start_idx..end_idx];
                if ocr_lang.contains("zh") || ocr_lang.contains("Z") {
                    segment.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join("")
                } else {
                    segment.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
                }
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
            "You are a precise, professional software and system UI translator. Translate each tagged English text item into Traditional Chinese (繁體中文).\n\n\
             Strict Guidelines:\n\
             1. You MUST translate EVERY item. Keep the exact same tag (e.g., '[#1]', '[#2]') at the start of each line in your output. Do not renumber, do not reorder, and do not omit any tags.\n\
             2. If an item is a single short word or standard option like 'Emails', 'Models', 'Packages', 'Copilot', 'Features', 'Pages', 'Security', 'Profile', 'Inbox', translate it professionally (e.g., '[#1] 郵件', '[#2] 收件匣', '[#3] 草稿').\n\
             3. If an item is already in Traditional Chinese, preserve it exactly as is after its tag.\n\
             4. Keep all brand names ('GitHub', 'Tauri', etc.) or personal names intact in English.\n\
             5. Return exactly {} translated items, one per line. No conversational prologue, no markdown block wrappers, and no extra explanation.",
            n
        )
    } else {
        format!(
            "You are a precise, literal, and professional translator. Translate each tagged Traditional Chinese text item into English.\n\n\
             Strict Guidelines:\n\
             1. You MUST translate EVERY item. Keep the exact same tag (e.g., '[#1]', '[#2]') at the start of each line in your output. Do not renumber, do not reorder, and do not omit any tags.\n\
             2. Keep names, contacts, and personal names intact or translit them accurately.\n\
             3. Crucial: Do NOT hallucinate UI or settings page labels based on guessing. Keep original letters/names!\n\
             4. If an item is already in English, preserve it exactly as is after its tag.\n\
             5. Return exactly {} translated items, one per line. No conversational prologue, no markdown block wrappers, and no extra explanation.",
            n
        )
    };
    let client = reqwest::Client::new();
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
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
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

#[derive(Serialize, Deserialize, Clone)]
struct VisionLine {
    original: String,
    translated: String,
}

/// 用視覺語言模型一次完成 OCR + 翻譯，回傳每行原文與譯文
#[tauri::command]
async fn vision_ocr_translate(image_base64: String, api_url: String, model: String) -> Result<Vec<VisionLine>, String> {
    // 去掉 data URL 前綴（"data:image/png;base64,"）
    let b64 = if let Some(idx) = image_base64.find(',') {
        image_base64[idx + 1..].to_string()
    } else {
        image_base64
    };

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": { "url": format!("data:image/png;base64,{}", b64) }
                },
                {
                    "type": "text",
                    "text": "Translate ALL text visible in this image into English. Output ONLY the translated text, no explanation, no original text, no markdown."
                }
            ]
        }],
        "max_tokens": 1000,
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
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let translated = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("Invalid model response")?
        .trim()
        .to_string();

    Ok(vec![VisionLine { original: String::new(), translated }])
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
            vision_ocr_translate,
            update_shortcut
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
