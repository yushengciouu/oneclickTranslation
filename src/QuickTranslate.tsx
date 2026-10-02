import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const SETTINGS_KEY = "screen-translator-settings";
const DEFAULT_SETTINGS = {
  apiUrl: "http://192.168.39.143:8001",
  model: "gemma-4:31B",
  shortcut: "Ctrl+Shift+T",
  ocrEngine: "offline",
};

export function QuickTranslate() {
  const [originalText, setOriginalText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [targetLang, setTargetLang] = useState<"zh" | "en">("zh");
  const [isLoading, setIsLoading] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPinnedRef = useRef(false);
  isPinnedRef.current = isPinned;

  const currentTextRef = useRef("");
  currentTextRef.current = originalText;

  // 取得全域設定
  const getSettings = () => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return DEFAULT_SETTINGS;
  };

  const doTranslate = async (text: string, lang: "zh" | "en") => {
    if (!text.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const settings = getSettings();
      const res = await invoke<string>("translate_selection", {
        text,
        targetLang: lang,
        apiUrl: settings.apiUrl,
        model: settings.model,
      });
      setTranslatedText(res);
    } catch (err: any) {
      console.error("選取翻譯出錯:", err);
      setError(typeof err === "string" ? err : err?.message || "翻譯失敗");
    } finally {
      setIsLoading(false);
    }
  };

  // 接收並處理新的選取文字
  const applySelectionText = useCallback(async (incoming?: string) => {
    let text = incoming;
    if (!text) {
      try {
        text = await invoke<string>("get_latest_selection_text");
      } catch (err) {
        console.error("讀取最新選取文字失敗:", err);
      }
    }
    text = (text || "").trim();
    if (!text) return;

    // 若文字相同且已有譯文，避免無謂重複呼叫 LLM
    if (text === currentTextRef.current && translatedText) return;

    setOriginalText(text);
    setCopied(false);

    // 智慧語系判定：若選取文字中文字元佔比高於 25%，自動切換中翻英；否則為英翻繁中
    const chineseCharCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const detectedTarget: "zh" | "en" = chineseCharCount > text.length * 0.25 ? "en" : "zh";
    setTargetLang(detectedTarget);
    doTranslate(text, detectedTarget);
  }, [translatedText]);

  // 元件掛載時立即主動取得最新文字
  useEffect(() => {
    applySelectionText();
  }, [applySelectionText]);

  // 監聽後端傳來的選取文字事件
  useEffect(() => {
    const unlistenPromise = listen<string>("selection-text", (event) => {
      const text = event.payload?.trim() || "";
      if (text) {
        applySelectionText(text);
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [applySelectionText]);

  // 視窗取得焦點時（每次被叫起/顯示時）主動同步最新文字
  useEffect(() => {
    const handleFocus = () => {
      applySelectionText();
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [applySelectionText]);

  // 快捷鍵與視窗失焦自動關閉處理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_quick_window").catch(console.error);
      }
    };

    const handleBlur = () => {
      // 若未釘選，當使用者點擊到其他應用程式視窗失焦時自動隱藏
      if (!isPinnedRef.current) {
        invoke("hide_quick_window").catch(console.error);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const handleCopy = async () => {
    if (!translatedText) return;
    try {
      await navigator.clipboard.writeText(translatedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("複製失敗:", err);
    }
  };

  const handleToggleLang = () => {
    const nextLang = targetLang === "zh" ? "en" : "zh";
    setTargetLang(nextLang);
    if (originalText) {
      doTranslate(originalText, nextLang);
    }
  };

  const handleClose = () => {
    invoke("hide_quick_window").catch(console.error);
  };

  return (
    <div className="quick-container">
      {/* 標題拖曳列 */}
      <header className="quick-header" data-tauri-drag-region>
        <div className="quick-title" data-tauri-drag-region>
          <span className="quick-badge" data-tauri-drag-region>📝 劃詞翻譯</span>
          <span className="quick-direction-tag" data-tauri-drag-region>
            {targetLang === "zh" ? "英 ➔ 繁中" : "中 ➔ 英文"}
          </span>
        </div>
        <div className="quick-actions">
          <button
            className="quick-icon-btn"
            title="切換翻譯目標語言"
            onClick={handleToggleLang}
          >
            ⇄ {targetLang === "zh" ? "EN" : "中"}
          </button>
          <button
            className={`quick-icon-btn ${isPinned ? "pinned" : ""}`}
            title={isPinned ? "已釘選（點擊外部不關閉）" : "釘選視窗（保持在最上層）"}
            onClick={() => setIsPinned(!isPinned)}
          >
            {isPinned ? "📌 已釘選" : "📍 釘選"}
          </button>
          <button
            className="quick-icon-btn close-btn"
            title="關閉視窗 (Esc)"
            onClick={handleClose}
          >
            ✕
          </button>
        </div>
      </header>

      {/* 原文與譯文內容區 */}
      <div className="quick-content-wrap">
        <div className="quick-card original-card">
          <div className="quick-card-header">
            <span className="label">選取原文</span>
            <span className="count">{originalText.length} 字</span>
          </div>
          <div className="quick-text original-text">
            {originalText || "（尚未收到選取文字，請反白文字後，按著 Ctrl 不放並連按兩次 C）"}
          </div>
        </div>

        <div className="quick-card translated-card">
          <div className="quick-card-header">
            <span className="label">AI 即時譯文</span>
            {isLoading && <span className="status-loading">翻譯中...</span>}
          </div>
          <div className="quick-text translated-text">
            {isLoading ? (
              <div className="loading-placeholder">
                <div className="quick-spinner" />
                <span>AI 正在思考與翻譯中...</span>
              </div>
            ) : error ? (
              <div className="quick-error">{error}</div>
            ) : (
              translatedText || "（等待翻譯結果...）"
            )}
          </div>
        </div>
      </div>

      {/* 底部功能與操作列 */}
      <footer className="quick-footer">
        <div className="quick-footer-hint">
          {isPinned ? "📌 已鎖定視窗 · 按 Esc 隱藏" : "按著 Ctrl 連按兩次 C 觸發 · 按 Esc 隱藏"}
        </div>
        <div className="quick-footer-btns">
          <button
            className="quick-btn-secondary"
            title="重新呼叫 AI 翻譯"
            onClick={() => {
              if (originalText) {
                doTranslate(originalText, targetLang);
              } else {
                applySelectionText();
              }
            }}
            disabled={isLoading}
          >
            🔄 重試
          </button>
          <button
            className={`quick-btn-primary ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            disabled={!translatedText}
          >
            {copied ? "✓ 已複製" : "📋 複製譯文"}
          </button>
        </div>
      </footer>
    </div>
  );
}
