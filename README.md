# 島聲 FM

收聽台灣各地網路廣播，也能播放與管理自己的本地音樂。島聲 FM 是一款免安裝建置工具的靜態 PWA，支援桌面與行動裝置。

## 功能特色

- **探索台灣電台**：瀏覽 Radio Browser 社群目錄中的台灣電台，並提供縣市、人氣、警察廣播及我的最愛分類。
- **搜尋與篩選**：依電台名稱或資訊搜尋，按收聽次數或名稱排序，也可依縣市篩選。
- **收聽 KISS RADIO**：提供 Twitch 直播及 KISS RADIO 官方播放器選項。
- **播放本地音樂**：選取音樂檔案或整個資料夾建立播放清單，支援上一首、下一首、進度與音量控制、亂序播放及音量平衡。
- **安裝為 PWA**：可安裝至支援的瀏覽器與裝置，並快取應用程式介面。
- **響應式介面**：適用於不同螢幕尺寸。

## 使用方式

### 直接使用

以支援 PWA 的瀏覽器開啟部署好的網站，即可瀏覽電台或從「我的音樂」選取裝置上的音樂。若瀏覽器提供安裝提示，也可以將島聲 FM 安裝為 App。

### 本機執行

建議透過本機 HTTP 伺服器開啟，避免瀏覽器限制 Service Worker。此專案不需要安裝相依套件或執行建置。

```powershell
python -m http.server 8000
```

接著在瀏覽器開啟 <http://localhost:8000>。

## 部署至 GitHub Pages

1. 將專案檔案推送至 GitHub repository。
2. 開啟 repository 的 **Settings → Pages**。
3. 在 **Build and deployment** 選擇 **Deploy from a branch**。
4. 選擇要發布的分支及來源資料夾（通常為 `/(root)`），按下 **Save**。
5. 等待部署完成，使用 Pages 顯示的網址開啟網站。

本專案是純靜態網站，沒有建置步驟。請保持 `index.html`、`app.js`、`styles.css`、`manifest.json`、`sw.js` 與 `icon.svg` 位於相同的發布目錄。部署或更新後若仍看到舊版畫面，請重新整理頁面；Service Worker 會快取應用程式外殼。

## 本地音樂與隱私

音樂檔案由瀏覽器從使用者選取的檔案讀取並在本機播放，不會由此應用程式上傳。播放清單只存在目前頁面的記憶體中；重新載入頁面後需重新選取檔案。最愛電台則儲存在瀏覽器的 `localStorage`。

支援的音訊格式取決於瀏覽器；應用程式會辨識 MP3、M4A、AAC、OGG、OPUS、WAV、FLAC、AIFF、WMA 與 WebM 等格式。若瀏覽器不能直接播放 OPUS，首次解碼需要網路連線。

## 資料來源與注意事項

- 電台目錄由 [Radio Browser](https://www.radio-browser.info/) 社群 API 提供。
- KISS RADIO 播放器使用 KISS RADIO 官方頁面及 Twitch 嵌入播放器。
- 應用程式外殼可由 Service Worker 快取；**電台目錄、電台串流及外部播放器仍需網路連線**。快取頁面不代表可離線收聽網路電台。
- 串流可用性、播放格式及嵌入服務限制由各電台或服務提供者決定，可能因瀏覽器或地區而異。

## 專案檔案

| 檔案 | 用途 |
| --- | --- |
| `index.html` | 應用程式頁面與介面結構 |
| `styles.css` | 響應式樣式 |
| `app.js` | 電台目錄、播放控制與本地音樂功能 |
| `manifest.json` | PWA 名稱、圖示與顯示設定 |
| `sw.js` | 應用程式外殼快取 |
| `icon.svg` | 網站與 PWA 圖示 |

## 授權

目前 repository 尚未附上授權條款。如要允許他人重用或散布本專案，請先新增適合的 `LICENSE` 檔案。
