"use client";

import { useRef, useState, useCallback } from "react";

const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/hevc"];
const MAX_BYTES = 1024 * 1024 * 1024; // 1GB
const MAX_CONCURRENCY = 3; // Maximum concurrent uploads
const HASH_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB - only hash first chunk for speed
const PART_SIZE = 10 * 1024 * 1024; // 10MB multipart size

type UploadState = {
  name: string;
  progress: number;
  status: "pending" | "hashing" | "uploading" | "done" | "skipped" | "error";
  message?: string;
  previewUrl?: string;
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

  const createVideoThumbnail = (file: File): Promise<string | null> =>
    new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const video = document.createElement("video");
      let captured = false;

      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
      };

      const captureFrame = () => {
        if (captured) return;
        captured = true;
        const width = video.videoWidth || 160;
        const height = video.videoHeight || 90;
        const maxSide = 96;
        const scale = Math.min(1, maxSide / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          resolve(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          cleanup();
          resolve(dataUrl);
        } catch {
          cleanup();
          resolve(null);
        }
      };

      video.addEventListener("loadedmetadata", () => {
        const seekTo = Math.min(0.1, Math.max(0, video.duration / 4 || 0));
        if (Number.isFinite(seekTo) && seekTo > 0) {
          video.currentTime = seekTo;
        }
      }, { once: true });

      video.addEventListener("seeked", captureFrame, { once: true });
      video.addEventListener("loadeddata", captureFrame, { once: true });
      video.addEventListener("error", () => {
        cleanup();
        resolve(null);
      }, { once: true });

      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = objectUrl;
    });

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

  const requestJson = async <T,>(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "请求失败");
    }
    return (await resp.json()) as T;
  };

  const uploadPartWithProgress = (
    url: string,
    part: Blob,
    onProgress: (loaded: number) => void,
    signal?: AbortSignal,
  ) =>
    new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");

      if (signal) {
        signal.addEventListener("abort", () => {
          xhr.abort();
          reject(new Error("上传已取消"));
        });
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(e.loaded);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader("ETag")?.replace(/"/g, "");
          if (!etag) {
            reject(new Error("缺少 ETag，请检查 S3 CORS 暴露 ETag 头"));
            return;
          }
          resolve(etag);
        } else {
          reject(new Error("上传失败"));
        }
      };
      xhr.onerror = () => reject(new Error("上传失败"));
      xhr.send(part);
    });

  // Process a single file upload
  const processFile = async (file: File, signal?: AbortSignal): Promise<void> => {
    const fileName = file.name;
    let uploadId: string | undefined;
    let key: string | undefined;
    let bucket: string | undefined;

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
      const initResp = await requestJson<{
        uploadId?: string;
        key?: string;
        bucket?: string;
        duplicate?: boolean;
      }>(
        "/api/videos/multipart/init",
        {
          fileName: file.name,
          contentType: file.type,
          size: file.size,
          contentHash,
        },
        signal,
      );

      ({ uploadId, key, bucket } = initResp);
      const { duplicate } = initResp;

      if (duplicate) {
        updateItem(fileName, {
          status: "skipped",
          progress: 100,
          message: "已存在相同视频，跳过",
        });
        return;
      }

      if (!uploadId || !key || !bucket) {
        throw new Error("初始化上传失败");
      }

      const totalParts = Math.max(1, Math.ceil(file.size / PART_SIZE));
      const parts: { partNumber: number; etag: string }[] = [];
      let uploadedBytes = 0;

      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        if (signal?.aborted) {
          throw new Error("上传已取消");
        }
        const start = (partNumber - 1) * PART_SIZE;
        const end = Math.min(start + PART_SIZE, file.size);
        const blob = file.slice(start, end);

        const { uploadUrl } = await requestJson<{ uploadUrl: string }>(
          "/api/videos/multipart/part",
          {
            key,
            uploadId,
            partNumber,
          },
          signal,
        );

        const etag = await uploadPartWithProgress(
          uploadUrl,
          blob,
          (loaded) => {
            const pct = Math.round(((uploadedBytes + loaded) / file.size) * 100);
            updateItem(fileName, { progress: pct });
          },
          signal,
        );

        parts.push({ partNumber, etag });
        uploadedBytes += blob.size;
      }

      await requestJson(
        "/api/videos/multipart/complete",
        { key, uploadId, parts },
        signal,
      );

      // Notify backend
      await requestJson(
        "/api/videos/notify",
        {
          bucket,
          key,
          originalName: file.name,
          contentType: file.type,
          size: file.size,
          uploadedAt: new Date().toISOString(),
          contentHash,
        },
        signal,
      );

      updateItem(fileName, { progress: 100, status: "done" });
    } catch (err: any) {
      if (uploadId && key) {
        try {
          await requestJson("/api/videos/multipart/abort", { key, uploadId });
        } catch {
          // ignore abort errors
        }
      }
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

    // Generate local thumbnails (best-effort)
    fileArray.forEach((file) => {
      createVideoThumbnail(file).then((url) => {
        if (url) updateItem(file.name, { previewUrl: url });
      });
    });

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
              <div className="uploader__thumb" aria-hidden="true">
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt="" loading="lazy" />
                ) : (
                  <span>VIDEO</span>
                )}
              </div>
              <div className="uploader__details" style={{ flex: 1, minWidth: 0 }}>
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
