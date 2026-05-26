use base64::{engine::general_purpose, Engine as _};
use screenshots::Screen;
use screenshots::image::{DynamicImage, GrayImage, ImageFormat};
use serde::Serialize;
use std::io::Cursor;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 灰階 + Otsu 二值化 + 小圖放大，讓各種顏色文字都能被 OCR 辨識
/// 回傳 (PNG bytes, 放大倍率)，座標需除以倍率還原
fn preprocess_for_ocr(img: DynamicImage) -> (Vec<u8>, f64) {
    let gray: GrayImage = img.to_luma8();

    // Otsu 全域最佳閾值
    let mut histogram = [0u32; 256];
    for p in gray.pixels() {
        histogram[p[0] as usize] += 1;
    }
    let total = (gray.width() * gray.height()) as u64;
    let sum: u64 = histogram.iter().enumerate().map(|(i, &c)| i as u64 * c as u64).sum();
    let (mut sum_b, mut w_b, mut best_var, mut threshold) = (0u64, 0u64, 0.0f64, 128u8);
    for (i, &cnt) in histogram.iter().enumerate() {
        w_b += cnt as u64;
        if w_b == 0 { continue; }
        let w_f = total - w_b;
        if w_f == 0 { break; }
        sum_b += i as u64 * cnt as u64;
        let mb = sum_b as f64 / w_b as f64;
        let mf = (sum - sum_b) as f64 / w_f as f64;
        let var = w_b as f64 * w_f as f64 * (mb - mf).powi(2);
        if var > best_var { best_var = var; threshold = i as u8; }
    }

    // 二值化：文字像素→黑(0)，背景→白(255)
    let binary = GrayImage::from_fn(gray.width(), gray.height(), |x, y| {
        let v = gray.get_pixel(x, y)[0];
        if v <= threshold { screenshots::image::Luma([0u8]) } else { screenshots::image::Luma([255u8]) }
    });

    // 檢查：若黑色像素 > 50% 則反轉（深色背景亮色文字）
    let black_count = binary.pixels().filter(|p| p[0] == 0).count();
    let should_invert = black_count * 2 > (gray.width() * gray.height()) as usize;
    let final_img = if should_invert {
        GrayImage::from_fn(binary.width(), binary.height(), |x, y| {
            let v = binary.get_pixel(x, y)[0];
            screenshots::image::Luma([255 - v])
        })
    } else {
        binary
    };

    // 圖片太小時放大（Windows OCR 對小圖辨識率差）
    let (output_img, scale) = if final_img.height() < 80 || final_img.width() < 200 {
        let s = 2.0f32.max(80.0 / final_img.height() as f32).min(4.0);
        let nw = (final_img.width() as f32 * s) as u32;
        let nh = (final_img.height() as f32 * s) as u32;
        let up = screenshots::image::imageops::resize(
            &final_img, nw, nh,
            screenshots::image::imageops::FilterType::Lanczos3,
        );
        (up, s as f64)
    } else {
        (final_img, 1.0f64)
    };

    let mut buf = Cursor::new(Vec::new());
    DynamicImage::ImageLuma8(output_img).write_to(&mut buf, ImageFormat::Png).unwrap_or(());
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
async fn ocr_image(image_base64: String) -> Result<Vec<OcrLine>, String> {
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
            Language::CreateLanguage(&HSTRING::from("zh-Hant")).map_err(|e| e.to_string())?;
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
async fn translate_lines(texts: Vec<String>) -> Result<Vec<String>, String> {
    let combined = texts.join("\n");
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "gemma-4:31B",
        "messages": [
            { "role": "system", "content": "You are a translator. Translate the following Traditional Chinese text lines to English. Output ONLY the translated lines in the same order, one per line, no explanation." },
            { "role": "user", "content": combined }
        ],
        "temperature": 0.1
    });
    let resp = client
        .post("http://192.168.39.143:8001/v1/chat/completions")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("Invalid model response")?
        .to_string();
    Ok(content
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

#[tauri::command]
fn close_overlay(window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    window.set_always_on_top(false).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let shortcut =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyT);
            app.global_shortcut()
                .on_shortcut(shortcut, |app_handle, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("toggle-capture", ());
                        }
                    }
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_capture,
            close_overlay,
            ocr_image,
            translate_lines
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
