"use client";

import { useRef, useState, useCallback } from "react";

const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/hevc"];
const MAX_BYTES = 1024 * 1024 * 1024; // 1GB
const MAX_CONCURRENCY = 3; // Maximum concurrent uploads
const HASH_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB - only hash first chunk for speed

type UploadState = {
  name: string;
  progress: number;
  status: "pending" | "hashing" | "uploading" | "done" | "skipped" | "error";
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
  const abortControllerRef = useRef<AbortController | null>(null);

  const removeItem = (name: string) => {
    setItems((prev) => prev.filter((item) => item.name !== name));
  };

  const updateItem = useCallback((name: string, patch: Partial<UploadState>) => {
    setItems((prev) =>
      prev.map((item) => (item.name === name ? { ...item, ...patch } : item)),
    );
  }, []);

  // Fast hash using first chunk + file size for uniqueness
  const computeQuickHash = async (file: File): Promise<string> => {
    const chunkSize = Math.min(HASH_CHUNK_SIZE, file.size);
    const chunk = file.slice(0, chunkSize);
    const buffer = await chunk.arrayBuffer();

    // Combine chunk hash with file size for uniqueness
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    // Append file size to make it more unique
    return `${hashHex}-${file.size}`;
  };

  const uploadWithProgress = (
    url: string,
    file: File,
    onProgress: (pct: number) => void,
    signal?: AbortSignal,
  ) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("Content-Type", file.type);

      if (signal) {
        signal.addEventListener("abort", () => {
          xhr.abort();
          reject(new Error("上传已取消"));
        });
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onProgress(pct);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve();
        } else {
          reject(new Error("上传失败"));
        }
      };
      xhr.onerror = () => reject(new Error("上传失败"));
      xhr.send(file);
    });

  // Process a single file upload
  const processFile = async (file: File, signal?: AbortSignal): Promise<void> => {
    const fileName = file.name;

    // Validate file type and size first
    const extAllowed = ALLOWED_TYPES.includes(file.type);
    if (!extAllowed || file.size > MAX_BYTES) {
      updateItem(fileName, {
        status: "error",
        message: "文件类型或大小不符合要求",
      });
      return;
    }

    // Hash phase
    updateItem(fileName, { status: "hashing" });
    let contentHash = "";
    try {
      contentHash = await computeQuickHash(file);
    } catch {
      updateItem(fileName, { status: "error", message: "校验失败" });
      return;
    }

    if (signal?.aborted) {
      updateItem(fileName, { status: "error", message: "已取消" });
      return;
    }

    // Upload phase
    updateItem(fileName, { status: "uploading", progress: 0 });

    try {
      const presignResp = await fetch("/api/videos/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          size: file.size,
          contentHash,
        }),
        signal,
      });

      if (!presignResp.ok) {
        const data = (await presignResp.json()) as { error?: string };
        throw new Error(data.error || "获取上传地址失败");
      }

      const { uploadUrl, key, bucket, duplicate } = (await presignResp.json()) as {
        uploadUrl: string;
        key: string;
        bucket: string;
        duplicate?: boolean;
      };

      if (duplicate) {
        updateItem(fileName, {
          status: "skipped",
          progress: 100,
          message: "已存在相同视频，跳过",
        });
        return;
      }

      // Upload to S3
      await uploadWithProgress(
        uploadUrl,
        file,
        (pct) => updateItem(fileName, { progress: pct }),
        signal,
      );

      // Notify backend
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
          contentHash,
        }),
        signal,
      });

      updateItem(fileName, { progress: 100, status: "done" });
    } catch (err: any) {
      if (err?.name === "AbortError" || signal?.aborted) {
        updateItem(fileName, { status: "error", message: "已取消" });
      } else {
        const message = err?.message || "上传失败";
        updateItem(fileName, { status: "error", message });
      }
    }
  };

  const handleSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);

    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const queue: UploadState[] = Array.from(files).map((file) => ({
      name: file.name,
      progress: 0,
      status: "pending",
    }));
    setItems(queue);
    setBusy(true);

    // Convert FileList to array for easier handling
    const fileArray = Array.from(files);

    // Concurrent upload with limited concurrency
    const uploadQueue = [...fileArray];
    const activeUploads: Promise<void>[] = [];

    const startNext = async (): Promise<void> => {
      if (uploadQueue.length === 0 || signal.aborted) return;

      const file = uploadQueue.shift()!;
      await processFile(file, signal);
      await startNext();
    };

    // Start up to MAX_CONCURRENCY parallel upload workers
    const workers = Math.min(MAX_CONCURRENCY, fileArray.length);
    for (let i = 0; i < workers; i++) {
      activeUploads.push(startNext());
    }

    // Wait for all uploads to complete
    await Promise.all(activeUploads);

    setBusy(false);
    abortControllerRef.current = null;
    onUploaded?.();
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
    setBusy(false);
  };

  return (
    <div className="uploader">
      <div className="uploader__bar">
        <div>
          <h3>上传视频</h3>
          <p className="muted">支持 MOV / MP4 / HEVC，单个文件不超过 1GB。最多同时上传 {MAX_CONCURRENCY} 个。</p>
        </div>
        <div className="uploader__actions">
          <button
            className="dashboard-link"
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? "上传中..." : "选择文件"}
          </button>
          {busy && (
            <button
              className="pill pill--error"
              type="button"
              onClick={handleCancel}
              style={{ cursor: "pointer" }}
            >
              取消上传
            </button>
          )}
        </div>
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
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ellipsis">{item.name}</div>
                <div className="progress">
                  <div
                    className="progress__bar"
                    style={{
                      width: `${item.progress}%`,
                      background:
                        item.status === "error"
                          ? "#ef4444"
                          : item.status === "skipped"
                          ? "#9ca3af"
                          : "#16a34a",
                    }}
                  />
                </div>
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  {item.status === "hashing"
                    ? "校验中"
                    : item.status === "uploading"
                    ? `上传中 ${item.progress}%`
                    : item.status === "done"
                    ? "完成"
                    : item.status === "skipped"
                    ? item.message || "已跳过"
                    : item.status === "error"
                    ? item.message || "失败"
                    : "待上传"}
                </div>
              </div>
              {item.status !== "uploading" && item.status !== "hashing" ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭"
                  onClick={() => removeItem(item.name)}
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
