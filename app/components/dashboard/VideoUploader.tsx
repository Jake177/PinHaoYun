"use client";

import { useRef, useState } from "react";

const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/hevc"];
const MAX_BYTES = 1024 * 1024 * 1024; // 1GB

type UploadState = {
  name: string;
  progress: number;
  status: "pending" | "uploading" | "done" | "error";
  message?: string;
};

type VideoUploaderProps = {
  onUploaded?: () => void;
};

export default function VideoUploader({ onUploaded }: VideoUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<UploadState[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const queue: UploadState[] = Array.from(files).map((file) => ({
      name: file.name,
      progress: 0,
      status: "pending",
    }));
    setItems(queue);
    setBusy(true);

    for (const file of files) {
      setItems((prev) =>
        prev.map((item) =>
          item.name === file.name ? { ...item, status: "uploading" } : item,
        ),
      );
      const extAllowed = ALLOWED_TYPES.includes(file.type);
      if (!extAllowed || file.size > MAX_BYTES) {
        setError("文件类型或大小不符合要求");
        continue;
      }
      try {
        const presignResp = await fetch("/api/videos/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.type,
            size: file.size,
          }),
        });
        if (!presignResp.ok) {
          const data = (await presignResp.json()) as { error?: string };
          throw new Error(data.error || "获取上传地址失败");
        }
        const { uploadUrl, key, bucket } = (await presignResp.json()) as {
          uploadUrl: string;
          key: string;
          bucket: string;
        };

        // Upload to S3
        const putResp = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!putResp.ok) {
          throw new Error("上传失败");
        }

        // Notify backend to persist metadata
        await fetch("/api/videos/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bucket,
            key,
            originalName: file.name,
            contentType: file.type,
            size: file.size,
            uploadedAt: new Date().toISOString(),
          }),
        });

        setItems((prev) =>
          prev.map((item) =>
            item.name === file.name
              ? { ...item, progress: 100, status: "done" }
              : item,
          ),
        );
      } catch (err: any) {
        const message = err?.message || "上传失败";
        setError(message);
        setItems((prev) =>
          prev.map((item) =>
            item.name === file.name
              ? { ...item, status: "error", message }
              : item,
          ),
        );
      }
    }

    setBusy(false);
    onUploaded?.();
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="uploader">
      <div className="uploader__bar">
        <div>
          <h3>上传视频</h3>
          <p className="muted">支持 MOV / MP4 / HEVC，单个文件不超过 1GB。</p>
        </div>
        <button
          className="dashboard-link"
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "上传中..." : "选择文件"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.mov,.hevc,video/mp4,video/quicktime,video/hevc"
          multiple
          style={{ display: "none" }}
          onChange={(e) => handleSelect(e.target.files)}
        />
      </div>

      {error ? <p className="pill pill--error">{error}</p> : null}
      {items.length > 0 && (
        <ul className="uploader__list">
          {items.map((item) => (
            <li key={item.name} className="uploader__item">
              <span className="ellipsis">{item.name}</span>
              <span className="pill">
                {item.status === "uploading"
                  ? "上传中"
                  : item.status === "done"
                  ? "完成"
                  : item.status === "error"
                  ? "失败"
                  : "待上传"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
