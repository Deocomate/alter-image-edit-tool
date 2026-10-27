# Fix: sai tỉ lệ và ghép lệch layer đồ thờ

Ngày: 2026-10-27 · Trạng thái: đã sửa và đã kiểm thử offline (chưa chạy model thật)

## Nguyên nhân (đã chứng minh)

1. **Tỉ lệ bị bỏ qua với ảnh tách nền.** Khi ảnh đính kèm là PNG tách nền, dropdown tỉ lệ bị "khoá" nhưng vẫn bấm chọn được. Server luôn ép `aspectRatio = 'original'` (`server/index.js`, `effectiveAspect`), nên chọn 1:1 ở dropdown không có tác dụng gì. Tỉ lệ chỉ đổi được qua nút layout nhỏ trên ảnh đính kèm.
2. **Model không sinh được đúng tỉ lệ khung.** Bố cục mặc định dùng đúng tỉ lệ pixel của ảnh upload (ví dụ `6048:4032`), và dropdown liệt kê cả những tỉ lệ model không hỗ trợ (ví dụ 4:5 hay 5:4 trên GPT-image). Server xin tỉ lệ gần nhất mà model có, sau đó kéo giãn ảnh model trả về cho vừa khung bằng `fit: 'fill'`. Kết quả là nền bị giãn không đều (lệch tới khoảng 6.7%) và sản phẩm model vẽ không còn trùng với layer gốc.
3. **Thuật toán căn khớp quá hẹp.** `estimateAlignment` chỉ tìm trong phạm vi scale ±6% và dịch ±4%. Khi model vẽ lại khung cảnh (ví dụ thu nhỏ sản phẩm 15–25% để vừa bàn thờ vuông), thuật toán trả kết quả sai. Repro: model thu nhỏ còn 0.75 thì thuật toán cũ ước lượng ra 0.93. Hệ quả là sản phẩm gốc bị dán đè lên sản phẩm model vẽ ở cỡ khác, để lại bóng ma.
4. **Hướng sửa cũ cũng sai.** Code cũ phóng to hoặc thu nhỏ nền cho khớp với cutout, nên nền bị crop và upscale, và phần mép được bù bằng cách lặp pixel (`extendWith: 'copy'`). Như vậy là phá luôn bố cục hợp lý mà model đã chọn.

## Đã sửa

| Thay đổi | File |
|---|---|
| Dropdown tỉ lệ hoạt động với ảnh tách nền: chọn tỉ lệ sẽ dựng lại khung ngay. Dropdown và layout editor chỉ liệt kê tỉ lệ model hỗ trợ. Bố cục mặc định lấy tỉ lệ được hỗ trợ gần với ảnh upload nhất. | `public/app.js`, `public/layout-editor.js` |
| Lưới an toàn phía server: khung cutout được nới bằng lề trong suốt cho đúng tỉ lệ model hỗ trợ (`padToRatio`), nên ảnh model luôn scale đều, không bị giãn. | `server/index.js`, `server/image-pipeline.js` |
| Căn khớp mới: tìm coarse-to-fine với scale 0.7–1.3 và dịch ±15%, chấm điểm bằng normalized cross-correlation (chịu được việc model đổi ánh sáng). Trên ảnh mẫu thật, thuật toán bắt đúng scale 0.75–1.15 và lệch tối đa khoảng 2px trên khung 2000px, mất khoảng 0.7s. | `estimateAlignment` |
| Đảo chiều ghép: giữ nguyên nền model, đặt layer sản phẩm gốc vào đúng vị trí và kích thước model đã vẽ. Bóng đổ và mặt bàn vì thế khớp với sản phẩm. Dịch thuần thì giữ 100% pixel; đổi cỡ thì resample Lanczos một lần. | `placeCutout`, `compositeCutout` |
| Prompt: thêm yêu cầu dựng bàn thờ theo đúng tỉ lệ sản phẩm, không zoom, phủ kín khung. | `buildCutoutPrompt` |
| Meta kết quả hiển thị "khớp 92%, sản phẩm ×0.85" để biết khi nào nên tạo lại. | `public/app.js` |

Kiểm thử: `npm test` pass 14/14, trong đó có 3 test mới (model thu nhỏ hoặc phóng to sản phẩm, không còn bóng ma, padding tỉ lệ). Smoke test các endpoint upload và layout đều trả đúng tỉ lệ 1:1, 4:5 và 16:9.

## Còn lại và phương án tiếp theo (brainstorm)

1. **Model dời từng món riêng lẻ** (ví dụ dời bát hương sang trái nhưng giữ lọ hoa) thì một phép biến đổi toàn cục không khắc phục được. Phương án: tách cutout thành các vùng alpha liên thông, căn từng món trong cửa sổ nhỏ (khoảng ±3%) quanh kết quả toàn cục. Khoảng 60 dòng code. Nên làm nếu meta thường báo "khớp" dưới 70%.
2. **Best-of-N theo điểm khớp:** gửi 2–3 lượt và tự chọn kết quả có điểm khớp cao nhất. Cách này giảm "random" mạnh nhất nhưng chi phí tăng gấp N. Nên làm thành tuỳ chọn.
3. **Seed:** OpenRouter có `seed` cho Qwen, Seedream, FLUX.2, Krea và Hunyuan (không có cho Gemini và GPT-image). Seed giúp tái lập kết quả, nhưng không làm model bám bố cục chặt hơn.
4. **Inpainting có mask** (model chỉ vẽ phần nền, giữ nguyên pixel sản phẩm) là cách triệt để nhất, nhưng endpoint `/api/v1/images` của OpenRouter hiện không có tham số mask.
5. **Mask brush với ảnh thường** vẫn còn lỗi giãn cùng loại (`compositeWithMask` dùng `fit: 'fill'`) khi tỉ lệ ảnh không nằm trong danh sách model hỗ trợ. Mức ảnh hưởng thấp hơn.

## Gợi ý model (từ danh sách OpenRouter hiện tại)

| Model | Lý do | Lưu ý |
|---|---|---|
| `google/gemini-3-pro-image` (mặc định) | Có 4K native, 10 tỉ lệ (có 4:5 và 5:4), nhận tới 14 ảnh tham chiếu | Không có seed |
| `bytedance-seed/seedream-4.5` | Có 4K, nhiều tỉ lệ, có seed, `n` tối đa 10 (hợp với best-of-N) | |
| `black-forest-labs/flux.2-max` / `flux.2-pro` | Có seed, xuất PNG | Không có tham số resolution (model tự chọn) |
| Tránh: `openai/gpt-image-*` | Dữ liệu session cho thấy chỉ tạo 1536×1024, nên phải phóng to lên 3840. Ít tỉ lệ (không có 4:5, 5:4) | |

Các nhận định về độ "bám bố cục" của từng model chưa được đo. Cách đo khách quan: chạy cùng một cutout và cùng một prompt qua 3–4 model, so sánh điểm "khớp" và scale trong meta. Việc này tốn credit OpenRouter nên cần người dùng đồng ý.

## Câu hỏi chưa giải quyết

- Có chạy benchmark model trả phí (khoảng 4 model × 2 lượt) để chọn model mặc định dựa trên điểm khớp không?
- Có làm phương án 1 (căn từng món) và/hoặc phương án 2 (best-of-N) không?
