import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type AppMode = "idle" | "selecting" | "selected" | "processing" | "result";
type Lang = "zh" | "en";
type TransDir = "zh-en" | "en-zh";
type OcrEngine = "windows" | "offline";

const SETTINGS_KEY = "screen-translator-settings";
const DEFAULT_SETTINGS = {
  apiUrl: "http://192.168.39.143:8001",
  model: "gemma-4:31B",
  shortcut: "Ctrl+Shift+T",
  ocrEngine: "offline" as OcrEngine,
};

interface AppSettings {
  apiUrl: string;
  model: string;
  shortcut: string;
  ocrEngine: OcrEngine;
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // 若為舊版設定升級，自動將預設 OCR 引擎切換為 PP-OCRv5
      const hasEngineVersion = localStorage.getItem("screen-translator-engine-version");
      if (!hasEngineVersion) {
        localStorage.setItem("screen-translator-engine-version", "v5");
        parsed.ocrEngine = "offline";
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
      }
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const DIR_LABEL: Record<TransDir, string> = { "zh-en": "中→英", "en-zh": "英→中" };

const LOCALE = {
  zh: {
    title: "Screen Translator",
    subtitle: "按 Ctrl+Shift+T 或點按鈕開始截圖翻譯",
    startBtn: "開始截圖",
    fullScreenBtn: "一鍵全頁翻譯",
    hint: "拖曳選取範圍 · 按空白鍵全頁翻譯 · Esc 取消",
    processing: "OCR 辨識中...",
    reselect: "重新選取",
    close: "關閉",
    translate: "翻譯",
    copyBtn: "📋 複製譯文",
    copiedBtn: "✓ 已複製",
    noText: "未辨識到任何文字",
    langToggle: "EN",
  },
  en: {
    title: "Screen Translator",
    subtitle: "Press Ctrl+Shift+T or click the button to start",
    startBtn: "Start Capture",
    fullScreenBtn: "Full Page Translate",
    hint: "Drag to select \u00b7 Space for full page \u00b7 Esc to cancel",
    processing: "Recognizing...",
    reselect: "Reselect",
    close: "Close",
    translate: "Translate",
    copyBtn: "📋 Copy Text",
    copiedBtn: "✓ Copied",
    noText: "No text recognized",
    langToggle: "\u4e2d",
  },
} as const;

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
  maxSafeWidth?: number;
}

// 從共用 Canvas 取樣 bounding box 的主導背景色（排除前景文字雜訊，單一 Canvas 複用）
function sampleBgColorFromCtx(
  ctx: CanvasRenderingContext2D | null,
  W: number,
  H: number,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  if (!ctx) return "#ffffff";
  const rx = Math.max(0, Math.min(Math.round(x), W - 1));
  const ry = Math.max(0, Math.min(Math.round(y), H - 1));
  const rw = Math.max(1, Math.min(Math.round(w), W - rx));
  const rh = Math.max(1, Math.min(Math.round(h), H - ry));

  try {
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    const colors: { r: number; g: number; b: number; lum: number }[] = [];
    
    // 大區域時採用步長抽樣，大幅加速計算
    const step = d.length > 4000 ? 8 : 4;
    for (let i = 0; i < d.length; i += step) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const a = d[i + 3];
      if (a < 50) continue; // 忽略透明像素
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      colors.push({ r, g, b, lum });
    }

    if (colors.length === 0) return "#ffffff";

    // 使用偏向兩極群組中位數統計：
    // 在有文字的地方，像素中不是背景色（佔大多數）就是文字筆劃顏色（佔少數，且通常是深黑或純白等極端顏色）。
    // 我們先找出亮度的中位數，如果是亮背景（中位數 > 127），背景色會集中在亮端，進一步取 35% ~ 95% 的平均；
    // 如果是暗背景（中位數 <= 127），背景色集中在暗端，進一步取 5% ~ 65% 的平均。
    // 這能達到近乎完美地排乾除文字筆劃（反差極端色）雜訊，還原最真實的背景純色！
    colors.sort((a, b) => a.lum - b.lum);
    const medianLum = colors[Math.floor(colors.length / 2)].lum;
    
    let validSrc;
    if (medianLum > 127) {
      // 亮色背景：拋棄最暗的 35%（通常是黑色字體筆劃及其抗鋸齒邊緣）
      const start = Math.floor(colors.length * 0.35);
      const end = Math.floor(colors.length * 0.95);
      validSrc = colors.slice(start, end);
    } else {
      // 暗色背景：拋棄最亮的 35%（通常是白色字體筆劃其暈開邊緣）
      const start = Math.floor(colors.length * 0.05);
      const end = Math.floor(colors.length * 0.65);
      validSrc = colors.slice(start, end);
    }

    if (validSrc.length === 0) validSrc = colors;

    let rSum = 0, gSum = 0, bSum = 0;
    for (const c of validSrc) {
      rSum += c.r;
      gSum += c.g;
      bSum += c.b;
    }
    const count = validSrc.length;
    return `rgb(${Math.round(rSum / count)},${Math.round(gSum / count)},${Math.round(bSum / count)})`;
  } catch (e) {
    console.error("取樣背景色失敗:", e);
    return "#ffffff";
  }
}

// 根據文字長度、高度、可用最大寬度，動態計算最適合且不暴衝的字型大小與是否折行
function getAutoFontSize(
  text: string,
  height: number,
  maxSafeWidth: number | undefined,
  targetLang: string
): { fontSize: string; isMultiLine: boolean } {
  const isZh = targetLang === "zh";
  const isMultiLine = height >= 28;

  let baseSize: number;
  if (isMultiLine) {
    // 多行方塊（如表格雙行表頭、雙行按鈕）：每行實際行高約為 height / 2
    // 嚴格限制在 10.5px ~ 13.0px，絕不暴衝到 28px
    const effectiveLineHeight = height / 2;
    baseSize = isZh
      ? Math.max(10.5, Math.min(effectiveLineHeight * 0.62, 13.0))
      : Math.max(11.0, Math.min(effectiveLineHeight * 0.68, 13.5));
  } else {
    // 單行文字：字級限制在 10.0px ~ 13.5px
    baseSize = isZh
      ? Math.max(10.0, Math.min(height * 0.62, 13.5))
      : Math.max(10.5, Math.min(height * 0.68, 14.0));
  }

  // 若受到右鄰元件約束（如狹窄表格欄位），且為單行文字時，微幅收縮字級以盡可能完整塞入
  if (maxSafeWidth && !isMultiLine && text) {
    let zhChars = 0;
    let enChars = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 127) zhChars++;
      else enChars++;
    }
    const unitWidth = isZh ? 1.0 : 0.54;
    const estUnits = zhChars + enChars * unitWidth;
    const estWidth = estUnits * baseSize;
    if (estWidth > maxSafeWidth - 4) {
      const fitSize = (maxSafeWidth - 4) / Math.max(1, estUnits);
      baseSize = Math.max(9.5, Math.min(baseSize, fitSize));
    }
  }

  return { fontSize: `${baseSize.toFixed(1)}px`, isMultiLine };
}

// 根據背景亮度選擇深灰或柔白文字（避免刺眼純黑純白）
function contrastColor(bg: string): string {
  const m = bg.match(/\d+/g);
  if (!m || m.length < 3) return "#18181b";
  const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
  return lum > 0.5 ? "#18181b" : "#f4f4f5";
}

function cropImage(src: string, rect: Rect, padding = 32): Promise<{ dataUrl: string; padX: number; padY: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      // 左右與上下各自加上 padding 像素的高品質 Quiet Zone
      const targetW = rect.width + padding * 2;
      const targetH = rect.height + padding * 2;
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("No canvas context")); return; }
      
      // 1. 先用圖片裁剪中心外圍最左上角像素填充畫布背景，防止黑/白背景色突兀
      try {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = 1;
        tempCanvas.height = 1;
        const tempCtx = tempCanvas.getContext("2d");
        if (tempCtx) {
          tempCtx.drawImage(img, rect.x, rect.y, 1, 1, 0, 0, 1, 1);
          const pixel = tempCtx.getImageData(0, 0, 1, 1).data;
          ctx.fillStyle = `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`;
        } else {
          ctx.fillStyle = "#ffffff";
        }
      } catch {
        ctx.fillStyle = "#ffffff";
      }
      ctx.fillRect(0, 0, targetW, targetH);

      // 2. 將裁剪文字精確畫在畫布正中央（四周各有 32 像素的安全襯墊）
      ctx.drawImage(
        img,
        rect.x, rect.y, rect.width, rect.height, // 來源 crop
        padding, padding, rect.width, rect.height // 目的（帶有 32px 襯墊的中央區域）
      );
      
      resolve({
        dataUrl: canvas.toDataURL("image/png"),
        padX: padding,
        padY: padding,
      });
    };
    img.onerror = reject;
    img.src = src;
  });
}

function App() {
  const [mode, setMode] = useState<AppMode>("idle");
  const [lang, setLang] = useState<Lang>("zh");
  const [transDir, setTransDir] = useState<TransDir>("zh-en");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [translations, setTranslations] = useState<TranslationLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(loadSettings);
  const [isRecording, setIsRecording] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [copied, setCopied] = useState(false);

  const handleShortcutKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // 取得 Modifiers
    const keys: string[] = [];
    if (e.ctrlKey) keys.push("Ctrl");
    if (e.shiftKey) keys.push("Shift");
    if (e.altKey) keys.push("Alt");
    if (e.metaKey) keys.push("Super"); // Windows 鍵 / Command 鍵

    const key = e.key;
    // 避開單按修飾鍵 (Modifier key down) 的階段
    if (
      key !== "Control" &&
      key !== "Shift" &&
      key !== "Alt" &&
      key !== "Meta"
    ) {
      let keyName = key.toUpperCase();
      // 轉換特殊按鍵為 Tauri 規範
      if (keyName === "ARROWUP") keyName = "Up";
      else if (keyName === "ARROWDOWN") keyName = "Down";
      else if (keyName === "ARROWLEFT") keyName = "Left";
      else if (keyName === "ARROWRIGHT") keyName = "Right";
      else if (keyName === "ESCAPE") keyName = "Escape";
      else if (keyName === "ENTER") keyName = "Enter";
      else if (keyName === "BACKSPACE") keyName = "Backspace";
      else if (keyName === "DELETE") keyName = "Delete";
      else if (keyName === "TAB") keyName = "Tab";
      else if (keyName === " ") keyName = "Space";
      else if (keyName.length === 1) {
        // 一般字母/數字字元，維持原樣
        keyName = keyName;
      } else {
        // 特殊功能鍵 F1-F12，首字母大寫即可
        keyName = key.charAt(0).toUpperCase() + key.slice(1);
      }

      keys.push(keyName);
      const shortcutStr = keys.join("+");
      setDraftSettings(s => ({ ...s, shortcut: shortcutStr }));
      setIsRecording(false);
    }
  };

  const rawT = LOCALE[lang];
  const t = {
    ...rawT,
    subtitle: lang === "zh" 
      ? `按 ${settings.shortcut} 或點按鈕開始截圖翻譯` 
      : `Press ${settings.shortcut} or click the button to capture`,
  };

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
    setCopied(false);
  }, []);

  const handleToggle = useCallback(async (event?: any) => {
    if (modeRef.current !== "idle") { resetToIdle(); return; }
    setError(null);
    try {
      let img = event?.payload as string | undefined | null;
      if (!img) {
        img = await invoke<string>("start_capture");
      }
      setScreenshot(img);
      setSelection(null);
      setMode("selecting");
    } catch (err) {
      console.error("截圖失敗:", err);
    }
  }, [resetToIdle]);

  const handleTranslate = useCallback(async (overrideSel?: Rect, overrideScreenshot?: string) => {
    const activeSelection = overrideSel ?? selection;
    const activeScreenshot = overrideScreenshot ?? screenshot;
    if (!activeScreenshot || !activeSelection) return;
    setMode("processing");
    setStatusText(t.processing);
    setError(null);
    try {
      // 先載入截圖取得原生尺寸，計算 HiDPI 縮放比例
      const imgEl = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = activeScreenshot;
      });
      // 原生像素 / CSS 像素（HiDPI 時可能是 1.25、1.5、2.0 等）
      const scaleX = imgEl.naturalWidth / window.innerWidth;
      const scaleY = imgEl.naturalHeight / window.innerHeight;

      // 【根本解法：X 軸向左右各延伸 500 原生像素，確保 OCR 能看到完整的每一行文字】
      // 問題根源：若用戶框選很窄（例如只選 30px 寬），傳給 OCR 的裁切圖也很窄，
      // OCR 只看到每行文字的殘缺片段，無法辨識不完整的字。
      // 解決方案：X 軸在選取範圍左右各延伸 500 原生像素（約 400 CSS px）
      //   - 足以涵蓋側邊欄、清單、選單等任何 UI 控件的完整行寬
      //   - 不像全螢幕寬度那樣把整張圖拖進來降低縮放比例與 OCR 精度
      const expandPx = 500;
      const cropX0 = Math.max(0, Math.round(activeSelection.x * scaleX) - expandPx);
      const cropX1 = Math.min(imgEl.naturalWidth, Math.round((activeSelection.x + activeSelection.width) * scaleX) + expandPx);
      const captureRect: Rect = {
        x: cropX0,
        y: Math.round(activeSelection.y * scaleY),
        width: cropX1 - cropX0,
        height: Math.round(activeSelection.height * scaleY),
      };
      const padAmount = 32;
      const { dataUrl: cropped, padX, padY } = await cropImage(activeScreenshot, captureRect, padAmount);

      // Step 1：Windows OCR 取得每行文字與精確座標
      const ocrLang = transDir === "zh-en" ? "zh-Hant" : "en";
      const targetLang = transDir === "zh-en" ? "en" : "zh";
      const ocrEngine = settings.ocrEngine === "offline" ? "offline" : "windows";
      const ocrLines = await invoke<OcrLine[]>("ocr_image", { imageBase64: cropped, ocrLang, ocrEngine });
      
      console.log(`[OCR] 偵測語言為 ${ocrLang}，共擷取到 ${ocrLines.length} 行文字:`);
      console.table(ocrLines.map((l, idx) => ({ 索引: idx, 文字: l.text, X: Math.round(l.x), Y: Math.round(l.y), 寬: Math.round(l.width), 高: Math.round(l.height) })));

      if (ocrLines.length === 0) {
        setError(t.noText);
        setMode("selecting");
        return;
      }

      // Step 2：LLM 翻譯（品質比 Windows OCR 自帶翻譯好）
      const texts = ocrLines.map(l => l.text);
      const translated = await invoke<string[]>("translate_lines", {
        texts,
        targetLang,
        apiUrl: settings.apiUrl,
        model: settings.model,
      });

      console.log(`[LLM] 翻譯語言為 ${targetLang}，接收了 ${texts.length} 行，返回了 ${translated.length} 行譯文:`);
      console.table(ocrLines.map((l, idx) => ({ 原文: l.text, 譯文: translated[idx] || "（解析失敗/未返回）" })));

      // Step 3：座標換算（OCR 回傳的是相對於 cropped 帶有 padX/padY 安全緩衝的原生像素）
      //         因為裁切使用了絕對對齊的 activeSelection（無 Pad 偏移），
      //         所以換算回全螢幕 CSS pixels 時，直接百分之百等比對齊！
      // 【效能極致優化】：建立單一取樣畫布（willReadFrequently 啟用瀏覽器硬體讀取加速），避免每行文字重複建立 4K Canvas 重繪
      const sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = imgEl.naturalWidth;
      sampleCanvas.height = imgEl.naturalHeight;
      const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
      if (sampleCtx) {
        sampleCtx.drawImage(imgEl, 0, 0);
      }

      const resultBeforeFilter = ocrLines.map((line, i) => {
        // 先減去 padX/padY 還原為 cropped 之前無 Padding 的純物理座標，再換算為絕對螢幕 CSS 座標
        // cropX0 是裁切起始點（原生像素），除以 scaleX 得 CSS 像素的起始偏移
        const cropStartCssX = cropX0 / scaleX;
        const fx = cropStartCssX + (line.x - padX) / scaleX;
        const fy = activeSelection.y + (line.y - padY) / scaleY;
        const fw = line.width / scaleX;
        const fh = line.height / scaleY;

        // 【純 Y 軸過濾 + X 軸以用戶選取範圍為限】：
        // 只要這行文字的 Y 中心落在用戶的選取 Y 範圍內（加少量容差），就納入翻譯結果。
        // X 軸：文字必須與用戶選取的 X 範圍有交集（寬容 25px），確保只翻譯用戶關心的欄位。
        const centerY = fy + fh / 2;
        const marginY = Math.max(12, fh * 0.3);
        if (centerY < activeSelection.y - marginY || centerY > activeSelection.y + activeSelection.height + marginY) return null;

        // X 軸交集判斷：文字框右邊 > 選取框左邊 AND 文字框左邊 < 選取框右邊（加 25px 容差）
        const selLeft = activeSelection.x - 25;
        const selRight = activeSelection.x + activeSelection.width + 25;
        if (fx + fw < selLeft || fx > selRight) return null;

        // 跳過 LLM 沒有翻譯到的行（行數不對齊時）
        if (!translated[i]?.trim()) return null;

        // 【無損原位精密對齊技術 (Perfect Absolute Alignment)】：
        // 以前會使用 Math.max(activeSelection.x, fx) 甚至限制 boxW 不能超過 activeSelection.width。
        // 這會導致：若使用者選取框畫得太窄（少選、窄框選項），文字寬度與起始位置會被強硬擠壓而徹底位移並嚴重折行！
        // 我們直接以 OCR 精確定位的原始文字實際座標 (fx, fw) 來當作渲染的定位基準 (boxX, boxW)，
        // 這不管您的框選畫得再小再窄，譯文框都能像幽靈般 100% 精準與原文重疊！
        const boxX = fx;
        const boxW = fw;
        if (boxW <= 2) return null;

        const bgColor = sampleBgColorFromCtx(
          sampleCtx,
          imgEl.naturalWidth,
          imgEl.naturalHeight,
          boxX * scaleX, fy * scaleY,
          boxW * scaleX, Math.max(1, fh * scaleY),
        );
        return {
          original: line.text,
          translated: translated[i],
          x: boxX,
          y: fy,
          width: boxW,
          height: fh,
          bgColor,
          textColor: contrastColor(bgColor),
        };
      }).filter((t): t is TranslationLine => t !== null);

      // 釋放共用取樣畫布記憶體
      sampleCanvas.width = 0;
      sampleCanvas.height = 0;

      // 智慧水平碰撞偵測：在多欄表格、表單與緊湊工具列中，計算到右側相鄰元件的距離，防止文字向右穿透覆蓋鄰欄
      const finalTranslations = resultBeforeFilter.map((t, idx) => {
        let minDistanceToRight = Infinity;
        for (let j = 0; j < resultBeforeFilter.length; j++) {
          if (idx === j) continue;
          const other = resultBeforeFilter[j];
          // 檢查是否處於同一水平行（垂直重疊比例 > 35%）
          const yOverlap = Math.max(0, Math.min(t.y + t.height, other.y + other.height) - Math.max(t.y, other.y));
          const isSameRow = yOverlap > Math.min(t.height, other.height) * 0.35;
          
          // other 在 t 的右側（且不是同一位置）
          if (isSameRow && other.x > t.x + 3) {
            const dist = other.x - t.x;
            if (dist < minDistanceToRight) {
              minDistanceToRight = dist;
            }
          }
        }

        // 若右側有相鄰元件，限制最大安全寬度為相鄰距離 - 3px 間隙；
        // 若右側無相鄰元件（如側邊欄、表格最右欄、對話框），則不限制（可延伸至螢幕邊界）
        const maxSafeWidth = minDistanceToRight < Infinity
          ? Math.max(t.width, minDistanceToRight - 3)
          : undefined;

        return {
          ...t,
          maxSafeWidth,
        };
      });

      setTranslations(finalTranslations);
      setCopied(false);
      setMode("result");
    } catch (err) {
      setError(String(err));
      setMode("selecting");
    }
  }, [screenshot, selection, transDir, lang, settings.ocrEngine, settings.apiUrl, settings.model]);

  const handleFullScreenTranslate = useCallback(async () => {
    setError(null);
    try {
      let img = screenshot;
      if (!img) {
        img = await invoke<string>("start_capture");
        setScreenshot(img);
      }
      const fullRect: Rect = {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      setSelection(fullRect);
      await handleTranslate(fullRect, img);
    } catch (err) {
      console.error("全頁翻譯失敗:", err);
      setError(String(err));
    }
  }, [screenshot, handleTranslate]);

  const handleCopyAll = useCallback(async () => {
    if (translations.length === 0) return;
    const allText = translations.map(t => t.translated).join("\n");
    try {
      await navigator.clipboard.writeText(allText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("複製失敗:", err);
      setError("無法寫入剪貼簿");
    }
  }, [translations]);

  useEffect(() => {
    // 程式啟動時，自動讀取並向 Rust 註冊當前的用戶設定快捷鍵
    invoke("update_shortcut", { shortcutStr: settings.shortcut })
      .catch((err) => {
        console.error("無法初始化自訂快速鍵:", err);
        setError(`無法初始化自訂快速鍵: ${err}`);
      });
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    listen("toggle-capture", handleToggle).then((fn) => { cleanup = fn; });
    return () => cleanup?.();
  }, [handleToggle]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    listen<string>("ocr-status", (event) => {
      setStatusText(event.payload);
    }).then((fn) => { cleanup = fn; });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modeRef.current !== "idle") {
        resetToIdle();
      } else if (e.key === " " && modeRef.current === "selecting") {
        e.preventDefault();
        handleFullScreenTranslate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resetToIdle, handleFullScreenTranslate]);

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
        <button className="lang-toggle" onClick={() => setLang(l => l === "zh" ? "en" : "zh")}>{t.langToggle}</button>
        <button className="settings-btn" onClick={() => { setDraftSettings({ ...settings }); setShowSettings(true); }}>⚙</button>
        <h2>{t.title}</h2>
        <p>{t.subtitle}</p>
        <div className="dir-switch">
          <button
            className={transDir === "zh-en" ? "dir-btn active" : "dir-btn"}
            onClick={() => setTransDir("zh-en")}>
            {DIR_LABEL["zh-en"]}
          </button>
          <button
            className={transDir === "en-zh" ? "dir-btn active" : "dir-btn"}
            onClick={() => setTransDir("en-zh")}>
            {DIR_LABEL["en-zh"]}
          </button>
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <button onClick={handleToggle}>{t.startBtn}</button>
          {/* 暫時隱藏一鍵全頁翻譯按鈕，保留底層邏輯與空白捷徑功能
          <button onClick={handleFullScreenTranslate} style={{ backgroundColor: "#2ecc71" }}>{t.fullScreenBtn}</button>
          */}
        </div>

        {showSettings && (
          <div className="settings-overlay" onClick={() => { setShowSettings(false); setIsRecording(false); }}>
            <div className="settings-modal" onClick={e => e.stopPropagation()}>
              <h3>設定 / Settings</h3>
              <label>
                OCR 引擎 / OCR Engine
                <div className="ocr-engine-options">
                  <label className="ocr-engine-option">
                    <input
                      type="radio"
                      name="ocrEngine"
                      checked={draftSettings.ocrEngine === "offline"}
                      onChange={() => setDraftSettings(s => ({ ...s, ocrEngine: "offline" }))}
                    />
                    <span>PP-OCRv5</span>
                  </label>
                  <label className="ocr-engine-option">
                    <input
                      type="radio"
                      name="ocrEngine"
                      checked={draftSettings.ocrEngine === "windows"}
                      onChange={() => setDraftSettings(s => ({ ...s, ocrEngine: "windows" }))}
                    />
                    <span>Windows OCR</span>
                  </label>
                </div>
              </label>
              <label>
                自訂快捷鍵 / Custom Shortcut
                <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
                  <input
                    type="text"
                    value={isRecording ? "請按下鍵盤設定組合鍵..." : draftSettings.shortcut}
                    readOnly
                    onKeyDown={handleShortcutKeyDown}
                    style={{
                      flex: 1,
                      backgroundColor: isRecording ? "#2c1e4a" : "#2a2a3e",
                      borderColor: isRecording ? "#a29bfe" : "#555",
                      color: isRecording ? "#a29bfe" : "#e0e0e0",
                      fontWeight: isRecording ? "600" : "normal",
                      textAlign: "center",
                      cursor: "pointer",
                    }}
                    onClick={() => setIsRecording(true)}
                    placeholder="點擊並按下任意組合鍵"
                  />
                  {isRecording ? (
                    <button
                      className="btn-secondary"
                      style={{ padding: "8px 12px", height: "38px", margin: 0 }}
                      onClick={() => setIsRecording(false)}
                    >
                      取消
                    </button>
                  ) : (
                    <button
                      className="btn-primary"
                      style={{ padding: "8px 12px", height: "38px", margin: 0, backgroundColor: "#6c5ce7" }}
                      onClick={() => setIsRecording(true)}
                    >
                      錄製
                    </button>
                  )}
                </div>
              </label>
              <div className="settings-actions">
                <button className="btn-secondary" onClick={() => { setShowSettings(false); setIsRecording(false); }}>取消</button>
                <button className="btn-primary" onClick={async () => {
                  try {
                    await invoke("update_shortcut", { shortcutStr: draftSettings.shortcut });
                    saveSettings(draftSettings);
                    setSettings(draftSettings);
                    setShowSettings(false);
                    setError(null);
                  } catch (err) {
                    setError(`快速鍵註冊失敗（可能與作業系統其他軟體衝突）: ${err}`);
                  }
                }}>儲存</button>
              </div>
            </div>
          </div>
        )}
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

      {mode === "result" && translations.length > 0 && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {translations.map((t, i) => {
            const targetLang = transDir === "zh-en" ? "en" : "zh";
            const { fontSize: dynamicFontSize, isMultiLine } = getAutoFontSize(
              t.translated,
              t.height,
              t.maxSafeWidth,
              targetLang
            );
            const padX = 2.5;
            const padY = 1.5;

            // 最大寬度保護：若有相鄰右側元素，不可超過 maxSafeWidth；否則限制在螢幕邊界內
            const calculatedMaxWidth = t.maxSafeWidth
              ? `${Math.max(t.width + padX * 2, t.maxSafeWidth)}px`
              : `calc(100vw - ${Math.round(t.x - padX)}px - 10px)`;

            return (
              <div
                key={i}
                className="translation-box"
                title={`原文: ${t.original}\n譯文: ${t.translated}\n(懸浮可透視原文 / 點擊複製此行)`}
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(t.translated).catch(console.error);
                }}
                style={{
                  left: t.x - padX,
                  top: t.y - padY,
                  minWidth: t.width + padX * 2,
                  width: "max-content",
                  maxWidth: calculatedMaxWidth,
                  height: t.height + padY * 2,
                  fontSize: dynamicFontSize,
                  background: t.bgColor,
                  color: t.textColor,
                  boxShadow: `0 0 1px 1px ${t.bgColor}`,
                  lineHeight: 1.15,
                  whiteSpace: isMultiLine ? "normal" : "nowrap",
                  wordBreak: isMultiLine ? "break-word" : "keep-all",
                  textOverflow: isMultiLine ? "clip" : "ellipsis",
                  overflow: "hidden",
                  letterSpacing: targetLang === "zh" ? "0.01em" : "-0.01em",
                  fontWeight: 500,
                  zIndex: 10,
                }}
              >
                {t.translated}
              </div>
            );
          })}
        </div>
      )}

      {mode === "selecting" && <div className="hint">{t.hint}</div>}

      {mode === "processing" && (
        <div className="processing-overlay">
          <div className="spinner" />
          <span>{statusText || t.processing}</span>
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
              <button className="btn-secondary" onClick={() => setMode("selecting")}>{t.reselect}</button>
              <button className="btn-primary" onClick={() => handleTranslate()}>{t.translate}</button>
            </>
          )}
          {mode === "result" && (
            <>
              <button
                className="btn-primary"
                onClick={handleCopyAll}
                style={{
                  backgroundColor: copied ? "#2ecc71" : "#4f8ef7",
                  transition: "all 0.2s ease",
                }}
              >
                {copied ? t.copiedBtn : t.copyBtn}
              </button>
              <button className="btn-secondary" onClick={() => { setTranslations([]); setSelection(null); setMode("selecting"); setCopied(false); }}>{t.reselect}</button>
            </>
          )}
          <button className="btn-danger" onClick={resetToIdle}>{t.close}</button>
        </div>
      )}
    </div>
  );
}

export default App;
