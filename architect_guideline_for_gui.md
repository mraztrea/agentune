# Kiến trúc & Thuật toán xây dựng Music Player GUI (Agentune Clone)

Tài liệu này tổng hợp lại các thuật toán, luồng xử lý (logic) và phương pháp tìm kiếm/tải nhạc từ dự án `agentune` backend, được hiệu chỉnh lại để phục vụ cho việc xây dựng một ứng dụng có giao diện người dùng (GUI) kết hợp với các API AI (như Gemini, OpenAI).

---

## 1. Thuật toán Tìm kiếm & Giải quyết bài hát (Song Resolution)
Mục đích của bước này là từ đầu vào (Prompt của người dùng -> AI -> Tên bài hát/Nghệ sĩ), tìm được chính xác video/audio trên YouTube để phát.

**Luồng xử lý:**
1. **Chuẩn hóa Thông tin (Canonicalization):**
   - Khi có `Title` và `Artist` (do AI trích xuất hoặc người dùng nhập), hệ thống trước tiên nên gọi API của **Apple Music/iTunes API** (API này miễn phí và không cần authen) để tìm chính xác metadata gốc. Thao tác này giúp sửa lỗi chính tả từ người dùng/AI.
   - Ví dụ: Input: `Shape of you - Ed sheỏan` -> iTunes API -> `Shape of You - Ed Sheeran`.
2. **Xây dựng Query tìm kiếm YouTube:**
   - Mẫu 1: `[Nghệ sĩ] - [Tên bài hát] official audio` (Ưu tiên cao nhất)
   - Mẫu 2: `[Nghệ sĩ] [Tên bài hát]`
   - Mẫu 3: `[Tên bài hát] official audio`
3. **Tìm kiếm (Scraping):**
   - Sử dụng thư viện `@distube/ytsr` (Node.js) để cào dữ liệu từ trang tìm kiếm YouTube. Thư viện này rất nhanh và **KHÔNG CẦN API KEY**.
   - Nếu `@distube/ytsr` lỗi (do YouTube đổi giao diện, bị block rate limit), **Fallback** sang dùng `yt-dlp` với lệnh `ytsearch10:query` để cào 10 kết quả đầu tiên.
4. **Chấm điểm kết quả (Scoring Mechanism):**
   - Dùng thuật toán Word Overlap (trùng khớp từ ngữ) để chấm điểm giữa các kết quả YouTube trả về và Metadata chuẩn từ iTunes.
   - Cộng điểm nếu độ dài video nằm trong khoảng 2 phút đến 7 phút (loại bỏ lời mix dài 1 tiếng hoặc video Tiktok ngắn 30s).
   - Chọn bài có số điểm cao nhất làm luồng phát chính.

---

## 2. Logic Trích xuất luồng Âm thanh (Audio Extraction & Download)
Bạn không tải nguyên cả video mp4 về rồi mới phát, mà bạn sẽ stream trực tiếp luồng Audio. 

**Công cụ sử dụng:** `yt-dlp` (thông qua wrapper `youtube-dl-exec` cho Node).
**Thông số cấu hình (cli arguments):**
```bash
yt-dlp "URL_CỦA_VIDEO_YOUTUBE" --dump-json -f "bestaudio[ext=m4a]/bestaudio" --no-warnings
```
**Mục đích:**
- Chỉ lấy định dạng m4a (chuẩn âm thanh tốt, dung lượng nhẹ) hoặc luồng audio tốt nhất hiện có.
- Trả về JSON chứa thẻ `.url`. URL này là một link trực tiếp tới máy chủ lưu trữ (GoogleVideo) có thể tồn tại trong ~6 giờ. 

---

## 3. Quản lý Trình phát Nhạc (Audio Player Controller)
Ứng dụng GUI cần một Player ở dưới nền để stream cái URL vừa lấy được. 

**Phương pháp tối ưu (Sử dụng mpv):**
- Không nên dùng các thẻ `<audio>` của HTML5 nếu làm app Desktop độc lập vì có thể dính các giới hạn về codec. 
- Khởi chạy một tiến trình ngầm `mpv` (ứng dụng mã nguồn mở cực kỳ nhẹ, tối ưu tài nguyên).
- Sử dụng IPC (Inter-Process Communication): Khởi động `mpv` với cờ `--input-ipc-server`. 
- App GUI của bạn sẽ gửi các lệnh JSON (như Play, Pause, Set Volume, Seek) qua Socket vào tiến trình mpv.
- App liên tục lắng nghe event `property-change` từ mpv để lấy `time-pos` (cập nhật thanh tiến trình UI), `duration` và báo hiệu `idle-active` (bài hát đã kết thúc -> Trigger sang bài hát tiếp theo trong Queue).

---

## 4. Tích hợp AI (Sử dụng Gemini/OpenAI API)

Với ứng dụng có GUI thân thiện với người dùng, AI sẽ đóng vai trò phân tích ý định thay vì tự execute code như MCP.

**Kiến trúc Prompt:**
Khi người dùng nhập: *"Đang code bug stress quá, bật nhạc nào chill chill tý"*
Bạn gọi API OpenAI/Gemini với System Prompt (yêu cầu JSON response):
```json
// System Prompt định dạng trả về:
{
  "intent": "play_mood", // Có thể là "play_song", "pause", "skip"
  "keywords": ["lo-fi", "chill", "focus"],
  "suggested_artists": ["Lofi Girl", "ChilledCow"] // Nếu có
}
```

**Workflow tích hợp:**
1. User input GUI Text / Voice.
2. App gửi prompt đến LLM API.
3. LLM trả về JSON Model với chỉ thị cụ thể.
4. GUI đọc JSON:
   - Nếu là bật bài cụ thể (`play_song`): Gọi hàm [Thuật toán Tìm kiếm 1].
   - Nếu là nghe theo cảm xúc (`play_mood`): AI đã cho keywords -> Bạn gửi keywords này vào YouTube Search (`lo-fi chill playlist/mix`), chọn bài hoặc tạo một list -> Đưa vào Queue -> Gọi hàm [Trích xuất luồng 2] -> Đẩy vào [Player 3].
5. Cập nhật giao diện: Đổi icon mĩ thuật sang trạng thái Playing.

---

## 5. Quản lý Queue & Lịch sử (Database Storage)
- **Local DB**: Dùng `SQLite` (hoặc IndexedDB/LocalStorage nếu làm base Web App) để lưu bảng `play_history` và `taste_persona`.
- **Cấu trúc lưu trữ:**
   - Bảng lịch sử nghe nhạc: `id`, `title`, `artist`, `duration`, `played_at`, `skipped` (true/false).
   - Mỗi khi bài hát bật quá 30s thì tính là 1 lần nghe. Nếu skip sớm -> Đánh dấu `skipped` (để mốt AI ưu tiên né bài này ra).

---

## 6. Đề xuất Tech Stack cho GUI app mới
- **Framework Frontend**: `Electron` kết hợp với `React` hoặc `Vue`, HOẶC tối ưu nhất ở thời điểm hiện tại: **Tauri (với Rust backend và React/Svelte/Vue frontend)** -> App cực nhẹ và hiệu suất cao.
- **Xử lý Audio**: Cài bundle `mpv` đi kèm với bộ cài, gọi qua backend.
- **Thư viện Scraping nhạc**: `@distube/ytsr` & `youtube-dl-exec`. (Nếu dùng Tauri có thể xài port Rust của tệp `yt-dlp`).
- **AI Integration**: Dùng trực tiếp `@google/generative-ai` (Gemini) hoặc `openai` SDK, cung cấp ô nhập input API Key trong màn hình Settings của GUI.
