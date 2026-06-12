use base64::{engine::general_purpose, Engine as _};
use screenshots::Screen;
use screenshots::image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 小圖放大，讓 Windows OCR 對小選取範圍也有足夠解析度
/// Windows OCR 本身支援彩色圖，不需要二值化
/// 回傳 (PNG bytes, 放大倍率)，座標需除以倍率還原
fn preprocess_for_ocr(img: DynamicImage) -> (Vec<u8>, f64) {
    let (w, h) = (img.width(), img.height());

    // 圖片太小時放大（Windows OCR 對小圖辨識率差）
    let (output_img, scale) = if h < 80 || w < 200 {
        let s = (2.0f32).max(80.0 / h as f32).min(4.0);
        let nw = (w as f32 * s) as u32;
        let nh = (h as f32 * s) as u32;
        let up = screenshots::image::imageops::resize(
            &img.to_rgba8(), nw, nh,
            screenshots::image::imageops::FilterType::Lanczos3,
        );
        (DynamicImage::ImageRgba8(up), s as f64)
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
    let (src_desc, tgt_desc) = if target_lang == "zh" {
        ("English", "Traditional Chinese (繁體中文)")
    } else {
        ("Traditional Chinese", "English")
    };
    let combined = texts
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{}. {}", i + 1, t))
        .collect::<Vec<_>>()
        .join("\n");
    let system_prompt = format!(
        "You are a professional setting panel and technical text translator. Translate each numbered {} text item into {}. \
         \
         Strict Guidelines:\
         1. You MUST translate EVERY item. If an item is a single short word like 'Emails', 'Models', 'Packages', 'Copilot', 'Features', 'Pages', you MUST translate it accurately (e.g. '電子郵件', '模型', '套件', 'Copilot', '功能列表', '頁面').\
         2. Keep the translation concise and natural for software UI elements.\
         3. Keep non-translatable technical names like 'GitHub', 'Settebello', 'Jalveer', 'Marivex' or brand names intact if there's no standard translation.\
         4. Do NOT leave any item blank or untranslated. If you cannot translate, translate it to the best of your ability. Never omit items.\
         5. Output EXACTLY the same numbered format: '1. translation', '2. translation', etc. \
         6. Return exactly {} translated items. No conversational filler, no extra lines, and no markdown formatting.",
        src_desc, tgt_desc, n
    );
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

    // 解析 "N. text" 格式，按編號填入對應位置
    let mut result = vec![String::new(); n];
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(dot_pos) = trimmed.find(". ") {
            let num_str = &trimmed[..dot_pos];
            if num_str.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(num) = num_str.parse::<usize>() {
                    if num >= 1 && num <= n {
                        result[num - 1] = trimmed[dot_pos + 2..].trim().to_string();
                    }
                }
            }
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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

            let shortcut =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyT);
            
            let app_handle_clone = app.handle().clone();
            app.global_shortcut()
                .on_shortcut(shortcut, move |_, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let handle = app_handle_clone.clone();
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
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_capture,
            close_overlay,
            ocr_image,
            translate_lines,
            vision_ocr_translate
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
