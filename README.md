# Screen Translator

一款基於 Tauri + React + TypeScript 開發的桌面螢幕翻譯工具。

## 專案目標

1. 使用者按快捷鍵或按鈕
2. 進入截圖選取模式
3. 使用者框選範圍
4. 對該區域截圖
5. OCR 取得每段文字與 bounding box
6. 翻譯每段文字
7. 對原文字區域做背景修補 / 模糊 / 半透明遮罩
8. 在同樣位置畫上譯文
9. 顯示 overlay
10. 再按一次快捷鍵，關閉 overlay，恢復原畫面

## 開發啟動方式

### 環境需求

- [Node.js](https://nodejs.org/)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

### 安裝依賴

請先切換到專案目錄：

```bash
cd screen-translator
```

再安裝依賴：

```bash
npm install
```

### 啟動開發模式

在專案目錄下執行：

```bash
npm run tauri dev
```

同時啟動 Vite 前端開發伺服器與 Tauri 桌面應用程式視窗。

### 建置正式版本

```bash
npm run tauri build
```

## 推薦開發工具

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
