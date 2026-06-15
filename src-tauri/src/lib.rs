use base64::{engine::general_purpose, Engine as _};
use screenshots::Screen;
use screenshots::image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 採用動態高階縮放演算法，為中低解析度、精細菜單或深色背景中細小中文字體進行高階插值（Lanczos3）放大，
/// 這可以大幅提升 Windows OCR 的字符特徵辨識率，徹底根除漏字、漏行、邊框判定不全等頑疾！
fn preprocess_for_ocr(img: DynamicImage) -> (Vec<u8>, f64) {
    let (w, h) = (img.width(), img.height());

    let s = if w > 3000 || h > 2000 {
        1.0f64
    } else if w > 1600 || h > 1200 {
        1.5f64
    } else {
        2.0f64
    };

    let (output_img, scale) = if s > 1.0 {
        let nw = (w as f64 * s) as u32;
        let nh = (h as f64 * s) as u32;
        let up = screenshots::image::imageops::resize(
            &img.to_rgba8(), nw, nh,
            screenshots::image::imageops::FilterType::Lanczos3,
        );
        (DynamicImage::ImageRgba8(up), s)
    } else {
        (img, 1.0f64)
    };

    let mut buf = Cursor::new(Vec::new());
    output_img.write_to(&mut buf, ImageFormat::Png).unwrap_or(());
    (buf.into_inner(), scale)
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

        // 預處理：灰階 + Otsu 二值化 + 小圖放大
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
        for i in 0..line_count {
            let line = lines.GetAt(i).map_err(|e| e.to_string())?;
            let text = line.Text().map_err(|e| e.to_string())?.to_string();
            if text.trim().is_empty() {
                continue;
            }
            let words = line.Words().map_err(|e| e.to_string())?;
            let word_count = words.Size().map_err(|e| e.to_string())? as u32;
            let mut min_x = f32::MAX;
            let mut min_y = f32::MAX;
            let mut max_x = f32::MIN;
            let mut max_y = f32::MIN;
            for j in 0..word_count {
                let word = words.GetAt(j).map_err(|e| e.to_string())?;
                let b = word.BoundingRect().map_err(|e| e.to_string())?;
                min_x = min_x.min(b.X);
                min_y = min_y.min(b.Y);
                max_x = max_x.max(b.X + b.Width);
                max_y = max_y.max(b.Y + b.Height);
            }
            if min_x < f32::MAX {
                // 座標除以放大倍率，還原為原始圖片座標
                ocr_lines.push(OcrLine {
                    text,
                    x: min_x as f64 / scale,
                    y: min_y as f64 / scale,
                    width: (max_x - min_x) as f64 / scale,
                    height: (max_y - min_y) as f64 / scale,
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
    // 加入編號，要求 LLM 一定照原數對映回來
    let n = texts.len();
    let combined = texts
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{}. {}", i + 1, t))
        .collect::<Vec<_>>()
        .join("\n");

    // 針對翻譯方向 (中翻英 / 英翻中) 生成完全獨立且針對性強化的 System Prompt，
    // 徹底消除 local LLM（如 gemma 等）因雙向規則混雜導致的「主觀猜測選單按鈕功能」而把人名(如 柏安、吳秉昇)翻譯成 (Security、User Account) 的嚴重幻覺！
    let system_prompt = if target_lang == "zh" {
        format!(
            "You are a precise, professional software and system UI translator. Translate each numbered English text item into Traditional Chinese (繁體中文).\n\n\
             Strict Guidelines:\n\
             1. You MUST translate EVERY item. If an item is a single short word or standard option like 'Emails', 'Models', 'Packages', 'Copilot', 'Features', 'Pages', 'Security', 'Profile', translate it professionally (e.g. '電子郵件', '模型', '套件', 'Copilot', '功能列表', '頁面', '安全性', '個人檔案').\n\
             2. Keep all brand names ('GitHub', 'Tauri', 'Settebello', 'Jalveer' etc.) or personal names in English if there is no standard Chinese translation.\n\
             3. Keep the translation concise, premium, and natural for software buttons, sidebar menus, and UI components.\n\
             4. Do NOT leave any item blank or untranslated. If you cannot translate, translate it to the best of your ability. Never omit items.\n\
             5. Output EXACTLY the same numbered list format:\n\
             '1. [translation]'\n\
             '2. [translation]'\n\
             ... Keep numbers consecutive and aligned with input.\n\
             6. Return exactly {} translated items. No conversational prologue, no markdown block wrappers, and no extra explanation.",
            n
        )
    } else {
        format!(
            "You are a precise, literal, and professional translator. Translate each numbered Traditional Chinese text item into English.\n\n\
             Strict Guidelines:\n\
             1. You MUST translate EVERY item literally and accurately. Keep names, contacts, and personal names (e.g., '柏安' to 'Bo-An' or 'Po-An', '詠' to 'Yung', 'Doris' to 'Doris', '吳秉昇' to 'Wu Bing-Sheng'), brand names, and proper nouns intact or translit them accurately.\n\
             2. Crucial: Do NOT hallucinate UI or settings page labels based on guessing. For example, if an item is a personal name or contact, do NOT arbitrarily translate it into standard system settings page options like 'Security', 'Profile', or 'User Account'. Keep the actual letters/names!\n\
             3. Keep the translation concise and natural, but never omit or skip any items.\n\
             4. Output EXACTLY the same numbered list format:\n\
             '1. [translation]'\n\
             '2. [translation]'\n\
             ... Keep numbers consecutive and aligned with input.\n\
             5. Return exactly {} translated items. No conversational prologue, no markdown block wrappers, and no extra explanation.",
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

    // 極致強健 (Robust) 解析各種 LLM 回傳格式（處理各種點號、冒號、頓號、括號、Markdown 星號等）
    let mut result = vec![String::new(); n];
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // 尋找第一個數字及其範圍
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
                    // 跳過常見的分隔與 Markdown 修飾符：'.', ':', '、', ')', ']', '*', '-', ' ', '：', '"', '\'', '`' 等
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
