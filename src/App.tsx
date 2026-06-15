import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type AppMode = "idle" | "selecting" | "selected" | "processing" | "result";
type Lang = "zh" | "en";
type TransDir = "zh-en" | "en-zh";

const SETTINGS_KEY = "screen-translator-settings";
const DEFAULT_SETTINGS = {
  apiUrl: "http://192.168.39.143:8001",
  model: "gemma-4:31B",
  shortcut: "Ctrl+Shift+T",
};

interface AppSettings {
  apiUrl: string;
  model: string;
  shortcut: string;
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
}

// 從截圖取樣 bounding box 的主導背景色（排除前景文字雜訊）
function sampleBgColor(img: HTMLImageElement, x: number, y: number, w: number, h: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#ffffff";
  ctx.drawImage(img, 0, 0);

  const W = img.naturalWidth, H = img.naturalHeight;
  const rx = Math.max(0, Math.min(Math.round(x), W - 1));
  const ry = Math.max(0, Math.min(Math.round(y), H - 1));
  const rw = Math.max(1, Math.min(Math.round(w), W - rx));
  const rh = Math.max(1, Math.min(Math.round(h), H - ry));

  try {
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    const colors: { r: number; g: number; b: number; lum: number }[] = [];
    
    for (let i = 0; i < d.length; i += 4) {
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
    // 我們先找出亮度的中位數，如果是亮背景（中位數 > 127），背景色會集中在亮端，進一步取 35% ~ 90% 的平均；
    // 如果是暗背景（中位數 <= 127），背景色集中在暗端，進一步取 10% ~ 65% 的平均。
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

// 根據文字長度、寬度、高度，以及目前翻譯目標語言 (中文或英文)，動態計算最適合、最清晰舒適的字型大小
function getAutoFontSize(text: string, width: number, height: number, targetLang: string): string {
  if (!text) return "11px";
  
  let zhChars = 0;
  let enChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      zhChars++;
    } else {
      enChars++;
    }
  }

  const isZh = targetLang === "zh";

  if (isZh) {
    // 英文翻中文 (en-zh)：
    // 中文字體複雜度高、筆劃較多，需要至少 11px 才清晰。由於中文翻譯長度多半比英文原文短，
    // 為了保證大小層次分明（文章標題大、內文小），不應使用窄小的範圍硬性截斷。
    // 我們將基準字體與原始框高（height）直接成等比比例縮放（height * 0.72），最低 11.5px。
    const baseSize = Math.max(11.5, height * 0.72);
    const singleCharWidth = 0.98; // 中文接近 1:1 的正方形寬度
    const asciiCharWidth = 0.55;  // 半形字元寬度
    const expectedWidth = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize;

    if (expectedWidth > width) {
      // 動態判定：如果容器高度小於字體大小的 1.6 倍，說明空間只夠放單行文字
      if (height < baseSize * 1.6) {
        // 單行模式：盡可能縮小以容納，建置最低下限為 11px 以免字體太小模糊不清
        const fitSize = width / (zhChars * singleCharWidth + enChars * asciiCharWidth);
        return `${Math.max(11, Math.min(baseSize, fitSize)).toFixed(1)}px`;
      } else {
        // 多行模式
        const area = width * height;
        const requiredArea = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize * (baseSize * 1.35);
        if (requiredArea > area) {
          const ratio = Math.sqrt(area / requiredArea);
          return `${Math.max(11, Math.min(baseSize, baseSize * ratio)).toFixed(1)}px`;
        }
      }
    }
    return `${baseSize.toFixed(1)}px`;
  } else {
    // 中文翻英文 (zh-en)：
    // 英文雖然可讀性高，但如果基準字體和下界拉得太低，在日常螢幕閱讀時依然會顯得太小、吃力。
    // 我們同步將中翻英的文字比例調優：基準字體與原始框高成等比比例縮放 (height * 0.72)，
    // 同時將中翻英的最舒服閱讀下限字體從 9.5px 顯著拉高至 11px，保障英文在任何時候都大氣清晰、舒適好讀！
    const baseSize = Math.max(11.5, height * 0.72);
    const singleCharWidth = 0.95;
    const asciiCharWidth = 0.55;
    const expectedWidth = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize;

    if (expectedWidth > width) {
      if (height < baseSize * 1.6) {
        // 單行模式：盡可能縮小以容納，最低下限設為 11px，保障在中翻英時英文不要縮得太小
        const fitSize = width / (zhChars * singleCharWidth + enChars * asciiCharWidth);
        return `${Math.max(11, Math.min(baseSize, fitSize)).toFixed(1)}px`;
      } else {
        // 多行模式
        const area = width * height;
        const requiredArea = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize * (baseSize * 1.25);
        if (requiredArea > area) {
          const ratio = Math.sqrt(area / requiredArea);
          return `${Math.max(11, Math.min(baseSize, baseSize * ratio)).toFixed(1)}px`;
        }
      }
    }
    return `${baseSize.toFixed(1)}px`;
  }
}

// 根據背景亮度選擇黑或白文字
function contrastColor(bg: string): string {
  const m = bg.match(/\d+/g);
  if (!m || m.length < 3) return "#000000";
  const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
  return lum > 0.5 ? "#000000" : "#ffffff";
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
  const [resultSelection, setResultSelection] = useState<Rect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(loadSettings);
  const [isRecording, setIsRecording] = useState(false);

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
    setResultSelection(null);
    setError(null);
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
      const ocrLines = await invoke<OcrLine[]>("ocr_image", { imageBase64: cropped, ocrLang });
      
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
        let boxW = fw;
        if (boxW <= 2) return null;

        // 【極致自適應最小寬度安全保障演算法】：
        // 解決「Galler y」、「Y u n g」等英文譯文因為原中文選取框（如單字、雙字清單）太窄
        // 而被迫發生中斷、極醜陋單字內截斷換行（如 Yung 變成 Y \n u \n n \n g）的痛點！
        let zhCount = 0;
        let enCount = 0;
        const cleanTrans = translated[i].trim();
        for (let cIdx = 0; cIdx < cleanTrans.length; cIdx++) {
          if (cleanTrans.charCodeAt(cIdx) > 127) {
            zhCount++;
          } else {
            enCount++;
          }
        }

        // 推估將該段翻譯完美放入單行所需要的最低安全像素寬度
        const characterWidthEst = targetLang === "zh"
          ? (zhCount * 13.5 + enCount * 6.5) // 中文繁體筆劃大，預估單字寬 13.5px
          : (zhCount * 13.5 + enCount * 6.0); // 英文小寫字母，單字元預估寬 6.0px
        const safeMinWidth = characterWidthEst + 14; // 加上左右各自少許 padding 的安全寬度

        // 【高畫質安全寬度適配】：
        if (targetLang === "en") {
          // 中翻英：英文單字與字元長度通常比中文原文膨脹 1.3 ~ 1.6 倍。
          // 為了提供英文單字折行及長片語呼吸空間，適度微調增加 20% ~ 35% 寬度（限制最高增加 40px），
          // 這既給予英文完美的渲染緩衝，又絕對不會像以前一樣無底線拉長到螢幕邊緣破壞整片圖表！
          const expansion = Math.min(40, boxW * 0.3);
          boxW = boxW + expansion;
        } else {
          // 英翻中 (targetLang === "zh")：
          // 當原文是側邊欄、設定列表這類「極短單字/列表項」（例如 Emails、Models、Features、Pages），
          // 翻譯後的中文長度可能與英文相當甚至稍長，但原 OCR 偵測邊框「極窄」且「沒有緩衝邊緣」，
          // 這會導致翻譯後的中文因為寬度被壓得太死，被迫發生「極其醜陋的單字卡線強制斷行」（例如：電 子 郵 件 變成上下垂直三行、儲 存 庫 變成兩行）。
          // 解決方案：當偵測到偵測框寬度 w 較窄時，主動給予中文一個「最寬防折行補貼」（額外寬度：16px ~ 35px），
          // 這既能保證短清單項目絕對能在單行內優雅舒展不折行，又不會拉長到破壞地圖或排版！
          const paddingBonus = Math.max(16, Math.min(35, boxW * 0.4));
          boxW = boxW + paddingBonus;
        }

        // 雙重加固：為防單字內截斷，寬度必定大於最小安全寬度。
        boxW = Math.max(boxW, safeMinWidth);

        const bgColor = sampleBgColor(
          imgEl,
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

      // 【極致重疊安全與過濾演算法】：
      // Windows OCR 有時會對極為密集的清單，將「整行大字」與「裡面的細部拆分字詞」同時以多個重疊框回傳。
      // 或者是同一個文字被偵測了兩次（例如 Y 軸和高度近乎完全重合，且 X 座標有 80% 以上重疊）。
      // 為此，我們執行一次「同行重疊與子字元包含過濾」，將完全被大框包含的小框、或是重複偵測的雜訊直接剔除，
      // 這保證了最終渲染到 CSS 上的翻譯容器，絕不會出現原圖中那樣「同一個地方疊上下兩個不同詞彙、甚至重複翻譯覆蓋」的混亂場面！
      const result: TranslationLine[] = [];
      for (const current of resultBeforeFilter) {
        let isOverlappedAndSmaller = false;
        for (const other of resultBeforeFilter) {
          if (current === other) continue;
          
          // 定義 Y 軸與高度是否重合（同行）
          const yOverlaps = Math.abs(current.y - other.y) < Math.max(current.height, other.height) * 0.5;
          
          if (yOverlaps) {
            // 計算 X 軸重疊份量 (Intersection over Union / Containment)
            const curLeft = current.x;
            const curRight = current.x + current.width;
            const othLeft = other.x;
            const othRight = other.x + other.width;
            
            const overlapLeft = Math.max(curLeft, othLeft);
            const overlapRight = Math.min(curRight, othRight);
            
            if (overlapRight > overlapLeft) {
              const intersectionWidth = overlapRight - overlapLeft;
              const curWidth = current.width;
              
              // 如果 current 框被 other 框包含超過 75%，且 current 的面積或長度小於 other，
              // 代表 current 只是 large-text 內部的冗餘局部碎片偵測字詞，必需予以剔除！
              const containmentRatio = intersectionWidth / curWidth;
              if (containmentRatio > 0.75 && current.original.length < other.original.length) {
                isOverlappedAndSmaller = true;
                break;
              }
            }
          }
        }
        if (!isOverlappedAndSmaller) {
          result.push(current);
        }
      }

      console.log(`[過濾] 從未過濾前 ${resultBeforeFilter.length} 行，精細篩除冗餘碎片剩餘 ${result.length} 行。`);
      setTranslations(result);
      setResultSelection(activeSelection);
      setMode("result");
    } catch (err) {
      setError(String(err));
      setMode("selecting");
    }
  }, [screenshot, selection, transDir, lang]);

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
                API URL
                <input
                  type="text"
                  value={draftSettings.apiUrl}
                  onChange={e => setDraftSettings(s => ({ ...s, apiUrl: e.target.value }))}
                  placeholder="http://192.168.x.x:8001"
                  spellCheck={false}
                />
              </label>
              <label>
                Model
                <input
                  type="text"
                  value={draftSettings.model}
                  onChange={e => setDraftSettings(s => ({ ...s, model: e.target.value }))}
                  placeholder="gemma-4:31B"
                  spellCheck={false}
                />
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

      {mode === "result" && translations.length > 0 && resultSelection && (
        // clipping container：嚴格限制在選取範圍，overflow hidden
        <div style={{
          position: "absolute",
          left: resultSelection.x - 30, // 左右與上下給予充足的溢位溢出緩衝區，杜絕部分被微調加寬加高的翻譯方塊（尤其短字）被 Clipping 容器直接裁截掉、而露出原圖的視覺瑕疵！
          top: resultSelection.y - 15,
          width: resultSelection.width + 60,
          height: resultSelection.height + 30,
          overflow: "hidden",
          pointerEvents: "none",
        }}>
          {translations.map((t, i) => {
            const targetLang = transDir === "zh-en" ? "en" : "zh";
            const dynamicFontSize = getAutoFontSize(t.translated, t.width, t.height, targetLang);
            // 加上上下左右少許 padding/margin 偏移與尺寸膨脹補貼，確保完美蓋住原文
            const paddingOffset = 1.5; 
            return (
              <div key={i} className="translation-box" title={t.translated} style={{
                left: t.x - resultSelection.x + 30 - paddingOffset,
                top: t.y - resultSelection.y + 15 - paddingOffset,
                width: t.width + paddingOffset * 2,
                minHeight: t.height + paddingOffset * 2, // 既設 minHeight 避免單詞折行蓋不住，又限制高度差
                fontSize: dynamicFontSize,
                background: t.bgColor,
                color: t.textColor,
                // 高度特製化文字與排版設定
                lineHeight: targetLang === "zh" ? 1.35 : 1.25,
                // 為解決英文單字被垂直撕裂截斷的痛點（例如 Gallery 變成 Galler\ny），
                // 英文採用 "normal" (或 "keep-all") 來保持單字完整，絕不硬性於字母間裁斷折行！
                // 只有中文因為字元間無空格才允許隨意按字元 "break-all" 折行。
                wordBreak: targetLang === "zh" ? "break-all" : "normal",
                overflowWrap: targetLang === "zh" ? "anywhere" : "break-word",
                letterSpacing: targetLang === "zh" ? "0.02em" : "-0.012em",
                fontWeight: targetLang === "zh" ? 550 : 500,
              }}>
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
          <span>{t.processing}</span>
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
            <button className="btn-secondary" onClick={() => { setTranslations([]); setSelection(null); setMode("selecting"); }}>{t.reselect}</button>
          )}
          <button className="btn-danger" onClick={resetToIdle}>{t.close}</button>
        </div>
      )}
    </div>
  );
}

export default App;
