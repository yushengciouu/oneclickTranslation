import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type AppMode = "idle" | "selecting" | "selected" | "processing" | "result";

interface Rect { x: number; y: number; width: number; height: number; }

interface OcrLine { text: string; x: number; y: number; width: number; height: number; }

interface TranslationLine {
  original: string;
  translated: string;
  x: number;
  y: number;
  width: number;
  height: number;
  bgColor: string;
  textColor: string;
}

// 從截圖取樣 bounding box 邊框的平均背景色
function sampleBgColor(img: HTMLImageElement, x: number, y: number, w: number, h: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#ffffff";
  ctx.drawImage(img, 0, 0);

  const border = Math.max(3, Math.round(Math.min(w, h) * 0.12));
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
  const W = img.naturalWidth, H = img.naturalHeight;

  const regions = [
    [clamp(x, W), clamp(y, H), clamp(w, W - x), border],
    [clamp(x, W), clamp(y + h - border, H), clamp(w, W - x), border],
    [clamp(x, W), clamp(y, H), border, clamp(h, H - y)],
    [clamp(x + w - border, W), clamp(y, H), border, clamp(h, H - y)],
  ] as [number, number, number, number][];

  let r = 0, g = 0, b = 0, count = 0;
  for (const [sx, sy, sw, sh] of regions) {
    if (sw <= 0 || sh <= 0) continue;
    const d = ctx.getImageData(sx, sy, sw, sh).data;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; count++;
    }
  }
  if (count === 0) return "#ffffff";
  return `rgb(${Math.round(r/count)},${Math.round(g/count)},${Math.round(b/count)})`;
}

// 根據背景亮度選擇黑或白文字
function contrastColor(bg: string): string {
  const m = bg.match(/\d+/g);
  if (!m || m.length < 3) return "#000000";
  const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
  return lum > 0.5 ? "#000000" : "#ffffff";
}

function cropImage(src: string, rect: Rect): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("No canvas context")); return; }
      ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = src;
  });
}

function App() {
  const [mode, setMode] = useState<AppMode>("idle");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [translations, setTranslations] = useState<TranslationLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const modeRef = useRef<AppMode>("idle");
  const isDragging = useRef(false);
  const startPos = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const resetToIdle = useCallback(async () => {
    await invoke("close_overlay").catch(console.error);
    setMode("idle");
    setScreenshot(null);
    setSelection(null);
    setTranslations([]);
    setError(null);
  }, []);

  const handleToggle = useCallback(async () => {
    if (modeRef.current !== "idle") { resetToIdle(); return; }
    setError(null);
    try {
      const img = await invoke<string>("start_capture");
      setScreenshot(img);
      setSelection(null);
      setMode("selecting");
    } catch (err) {
      console.error("截圖失敗:", err);
    }
  }, [resetToIdle]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    listen("toggle-capture", handleToggle).then((fn) => { cleanup = fn; });
    return () => cleanup?.();
  }, [handleToggle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modeRef.current !== "idle") resetToIdle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resetToIdle]);

  const handleTranslate = useCallback(async (overrideSel?: Rect) => {
    const activeSelection = overrideSel ?? selection;
    if (!screenshot || !activeSelection) return;
    setMode("processing");
    setError(null);
    try {
      // 先載入截圖取得原生尺寸，計算 HiDPI 縮放比例
      const imgEl = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = screenshot!;
      });
      // 原生像素 / CSS 像素（HiDPI 時可能是 1.25、1.5、2.0 等）
      const scaleX = imgEl.naturalWidth / window.innerWidth;
      const scaleY = imgEl.naturalHeight / window.innerHeight;

      // padding 後的裁切範圍（CSS pixels）
      const PAD = 30;
      const cssX = Math.max(0, activeSelection.x - PAD);
      const cssY = Math.max(0, activeSelection.y - PAD);
      const cssW = Math.min(window.innerWidth - cssX, activeSelection.width + PAD * 2);
      const cssH = Math.min(window.innerHeight - cssY, activeSelection.height + PAD * 2);

      // 裁切時使用原生像素座標，確保 OCR 拿到完整解析度
      const nativeRect: Rect = {
        x: Math.round(cssX * scaleX),
        y: Math.round(cssY * scaleY),
        width: Math.round(cssW * scaleX),
        height: Math.round(cssH * scaleY),
      };
      const cropped = await cropImage(screenshot, nativeRect);
      const ocrLines = await invoke<OcrLine[]>("ocr_image", { imageBase64: cropped });
      if (ocrLines.length === 0) {
        setError("未辨識到任何文字");
        setMode("selecting");
        return;
      }
      const texts = ocrLines.map((l) => l.text);
      const translated = await invoke<string[]>("translate_lines", { texts });

      const result: TranslationLine[] = ocrLines.map((line, i) => {
        // OCR 座標是相對於 nativeRect 的原生像素，換算回 CSS pixels
        const fx = cssX + line.x / scaleX;
        const fy = cssY + line.y / scaleY;
        const fw = line.width / scaleX;
        const fh = line.height / scaleY;

        // 限制在原始選取範圍內，避免超出
        const clampX = Math.max(activeSelection.x, fx);
        const clampY = Math.max(activeSelection.y, fy);
        const clampW = Math.min(activeSelection.x + activeSelection.width, fx + fw) - clampX;
        const clampH = Math.min(activeSelection.y + activeSelection.height, fy + fh) - clampY;
        if (clampW <= 2 || clampH <= 2) return null; // 完全在選取範圍外，丟棄

        // 用原生像素座標取樣背景色
        const bgColor = sampleBgColor(
          imgEl,
          clampX * scaleX, clampY * scaleY,
          Math.max(1, clampW * scaleX), Math.max(1, clampH * scaleY),
        );
        return {
          original: line.text,
          translated: translated[i] ?? "",
          x: clampX,
          y: clampY,
          width: clampW,
          height: clampH,
          bgColor,
          textColor: contrastColor(bgColor),
        };
      }).filter((t): t is TranslationLine => t !== null);

      setTranslations(result);
      setMode("result");
    } catch (err) {
      setError(String(err));
      setMode("selecting");
    }
  }, [screenshot, selection]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (modeRef.current !== "selecting") return;
    isDragging.current = true;
    startPos.current = { x: e.clientX, y: e.clientY };
    setSelection({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current || !startPos.current) return;
    const x = Math.min(e.clientX, startPos.current.x);
    const y = Math.min(e.clientY, startPos.current.y);
    setSelection({ x, y, width: Math.abs(e.clientX - startPos.current.x), height: Math.abs(e.clientY - startPos.current.y) });
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!isDragging.current || !startPos.current) return;
    isDragging.current = false;
    const x = Math.min(e.clientX, startPos.current.x);
    const y = Math.min(e.clientY, startPos.current.y);
    const w = Math.abs(e.clientX - startPos.current.x);
    const h = Math.abs(e.clientY - startPos.current.y);
    if (w > 10 && h > 10) {
      handleTranslate({ x, y, width: w, height: h });
    }
  };

  if (mode === "idle") {
    return (
      <main className="idle-ui">
        <h2>Screen Translator</h2>
        <p>按 <kbd>Ctrl+Shift+T</kbd> 或點按鈕開始截圖翻譯</p>
        <button onClick={handleToggle}>開始截圖</button>
      </main>
    );
  }

  return (
    <div className="overlay" onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
      {screenshot && (
        <img src={screenshot} className="screenshot-bg" alt="screenshot" draggable={false} />
      )}

      {selection && selection.width > 0 && mode !== "result" && (
        <div className="selection-rect" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />
      )}

      {mode === "result" && translations.map((t, i) => (
        <div key={i} className="translation-box" style={{
          left: t.x, top: t.y, width: t.width, minHeight: t.height,
          background: t.bgColor,
          color: t.textColor,
        }}>
          {t.translated}
        </div>
      ))}

      {mode === "selecting" && <div className="hint">拖曳選取翻譯範圍 · Esc 取消</div>}

      {mode === "processing" && (
        <div className="processing-overlay">
          <div className="spinner" />
          <span>OCR 辨識中...</span>
        </div>
      )}

      {error && <div className="error-toast">{error}</div>}

      {(mode === "selected" || mode === "result") && (
        <div className="action-bar">
          {mode === "selected" && selection && (
            <span className="size-label">{Math.round(selection.width)} × {Math.round(selection.height)} px</span>
          )}
          {mode === "selected" && (
            <>
              <button className="btn-secondary" onClick={() => setMode("selecting")}>重新選取</button>
              <button className="btn-primary" onClick={() => handleTranslate()}>翻譯</button>
            </>
          )}
          {mode === "result" && (
            <button className="btn-secondary" onClick={() => { setTranslations([]); setSelection(null); setMode("selecting"); }}>重新選取</button>
          )}
          <button className="btn-danger" onClick={resetToIdle}>關閉</button>
        </div>
      )}
    </div>
  );
}

export default App;
