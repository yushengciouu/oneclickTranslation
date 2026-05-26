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

  const onMouseUp = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setMode((prev) => {
      if (prev !== "selecting") return prev;
      return selection && selection.width > 10 && selection.height > 10 ? "selected" : "selecting";
    });
  };

  const handleTranslate = useCallback(async () => {
    if (!screenshot || !selection) return;
    setMode("processing");
    setError(null);
    try {
      const cropped = await cropImage(screenshot, selection);
      const ocrLines = await invoke<OcrLine[]>("ocr_image", { imageBase64: cropped });
      if (ocrLines.length === 0) {
        setError("未辨識到任何文字");
        setMode("selected");
        return;
      }
      const texts = ocrLines.map((l) => l.text);
      const translated = await invoke<string[]>("translate_lines", { texts });
      const result: TranslationLine[] = ocrLines.map((line, i) => ({
        original: line.text,
        translated: translated[i] ?? "",
        x: selection.x + line.x,
        y: selection.y + line.y,
        width: line.width,
        height: line.height,
      }));
      setTranslations(result);
      setMode("result");
    } catch (err) {
      setError(String(err));
      setMode("selected");
    }
  }, [screenshot, selection]);

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
        <div key={i} className="translation-box" style={{ left: t.x, top: t.y, width: t.width, minHeight: t.height }}>
          <span className="translation-text">{t.translated}</span>
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
              <button className="btn-primary" onClick={handleTranslate}>翻譯</button>
            </>
          )}
          {mode === "result" && (
            <button className="btn-secondary" onClick={() => { setTranslations([]); setMode("selected"); }}>重新選取</button>
          )}
          <button className="btn-danger" onClick={resetToIdle}>關閉</button>
        </div>
      )}
    </div>
  );
}

export default App;
