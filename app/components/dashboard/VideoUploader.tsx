"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";

const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/hevc"];
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif"];
const LIVE_VIDEO_TYPES = ["video/quicktime"];
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const MAX_CONCURRENCY = 3; // Maximum concurrent uploads
const HASH_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB - only hash first chunk for speed
const PART_SIZE = 10 * 1024 * 1024; // 10MB multipart size

type UploadState = {
  id: string;
  name: string;
  progress: number;
  status: "pending" | "hashing" | "uploading" | "done" | "skipped" | "error";
  message?: string;
  previewUrl?: string;
};

type UploadTask = {
  id: string;
  file: File;
  mediaType: "VIDEO" | "PHOTO";
  mediaRole?: "image" | "liveVideo";
  photoId?: string;
};

type VideoUploaderProps = {
  onUploaded?: () => void;
  variant?: "default" | "inline";
  listTargetId?: string;
};

export default function VideoUploader({ onUploaded, variant = "default", listTargetId }: VideoUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<UploadState[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listHost, setListHost] = useState<HTMLElement | null>(null);
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const removeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!listTargetId) {
      setListHost(null);
      return;
    }
    setListHost(document.getElementById(listTargetId));
  }, [listTargetId]);

  const clearRemoveTimer = (id: string) => {
    const timer = removeTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      removeTimersRef.current.delete(id);
    }
  };

  const removeItem = (id: string) => {
    clearRemoveTimer(id);
    abortControllersRef.current.delete(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const updateItem = useCallback((id: string, patch: Partial<UploadState>) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const scheduleAutoRemove = (id: string) => {
    if (removeTimersRef.current.has(id)) return;
    const timer = setTimeout(() => {
      removeItem(id);
    }, 5000);
    removeTimersRef.current.set(id, timer);
  };

  const createPreview = (file: File): Promise<string | null> =>
    new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const isImage =
        file.type.startsWith("image/") ||
        ["jpg", "jpeg", "png", "heic", "heif"].includes(ext);
      let captured = false;

      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
      };

      if (isImage) {
        const img = new Image();
        img.onload = () => {
          if (captured) return;
          captured = true;
          const width = img.width || 160;
          const height = img.height || 90;
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
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          try {
            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            cleanup();
            resolve(dataUrl);
          } catch {
            cleanup();
            resolve(null);
          }
        };
        img.onerror = () => {
          cleanup();
          resolve(null);
        };
        img.src = objectUrl;
        return;
      }

      const video = document.createElement("video");
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

      video.addEventListener(
        "loadedmetadata",
        () => {
          const seekTo = Math.min(0.1, Math.max(0, video.duration / 4 || 0));
          if (Number.isFinite(seekTo) && seekTo > 0) {
            video.currentTime = seekTo;
          }
        },
        { once: true },
      );

      video.addEventListener("seeked", captureFrame, { once: true });
      video.addEventListener("loadeddata", captureFrame, { once: true });
      video.addEventListener(
        "error",
        () => {
          cleanup();
          resolve(null);
        },
        { once: true },
      );

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
      throw new Error(data.error || "Request failed.");
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
          reject(new Error("Upload cancelled."));
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
            reject(new Error("Missing ETag. Ensure your S3 CORS configuration exposes the ETag header."));
            return;
          }
          resolve(etag);
        } else {
          reject(new Error("Upload failed."));
        }
      };
      xhr.onerror = () => reject(new Error("Upload failed."));
      xhr.send(part);
    });

  // Process a single file upload
  const processFile = async (task: UploadTask, signal: AbortSignal): Promise<void> => {
    const { id, file, mediaType, mediaRole = "image", photoId } = task;
    const fileName = file.name;
    let uploadId: string | undefined;
    let key: string | undefined;
    let bucket: string | undefined;

    // Validate file type and size first
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    const isImage =
      ALLOWED_IMAGE_TYPES.includes(file.type) ||
      ["jpg", "jpeg", "png", "heic", "heif"].includes(ext);
    const isLiveVideo = LIVE_VIDEO_TYPES.includes(file.type) || ext === "mov";
    const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type);
    const typeAllowed =
      mediaType === "PHOTO"
        ? mediaRole === "liveVideo"
          ? isLiveVideo
          : isImage
        : isVideo;
    if (!typeAllowed || file.size > MAX_BYTES) {
      updateItem(id, {
        status: "error",
        message: "Unsupported file type or file size is too large.",
      });
      return;
    }

    // Hash phase
    updateItem(id, { status: "hashing" });
    let contentHash = "";
    try {
      contentHash = await computeQuickHash(file);
    } catch {
      updateItem(id, { status: "error", message: "Failed to calculate checksum." });
      return;
    }

    if (signal?.aborted) {
      updateItem(id, { status: "error", message: "Cancelled." });
      return;
    }

    // Upload phase
    updateItem(id, { status: "uploading", progress: 0 });

    try {
      const initResp = await requestJson<{
        uploadId?: string;
        key?: string;
        bucket?: string;
        duplicate?: boolean;
        photoId?: string;
      }>(
        "/api/videos/multipart/init",
        {
          fileName: file.name,
          contentType: file.type,
          size: file.size,
          contentHash,
          mediaType,
          mediaRole,
          photoId,
        },
        signal,
      );

      ({ uploadId, key, bucket } = initResp);
      const { duplicate } = initResp;

      if (duplicate) {
        updateItem(id, {
          status: "skipped",
          progress: 100,
          message: "Duplicate detected. Skipped.",
        });
        return;
      }

      if (!uploadId || !key || !bucket) {
        throw new Error("Failed to initialise upload.");
      }

      const totalParts = Math.max(1, Math.ceil(file.size / PART_SIZE));
      const parts: { partNumber: number; etag: string }[] = [];
      let uploadedBytes = 0;

      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        if (signal?.aborted) {
          throw new Error("Upload cancelled.");
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
            updateItem(id, { progress: pct });
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
          mediaType,
          mediaRole,
          photoId,
        },
        signal,
      );

      updateItem(id, { progress: 100, status: "done" });
      scheduleAutoRemove(id);
    } catch (err: any) {
      if (uploadId && key) {
        try {
          await requestJson("/api/videos/multipart/abort", { key, uploadId });
        } catch {
          // ignore abort errors
        }
      }
      if (err?.name === "AbortError" || signal?.aborted) {
        updateItem(id, { status: "error", message: "Cancelled." });
      } else {
        const message = err?.message || "Upload failed.";
        updateItem(id, { status: "error", message });
      }
    }
  };

  const handleSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);

    const fileArray = Array.from(files);
    const photoIdByBase = new Map<string, string>();
    const getBaseName = (name: string) => name.replace(/\.[^/.]+$/, "");
    const isImageFile = (file: File) => {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      return (
        ALLOWED_IMAGE_TYPES.includes(file.type) ||
        ["jpg", "jpeg", "png", "heic", "heif"].includes(ext)
      );
    };

    const isLiveVideoFile = (file: File) => {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      return LIVE_VIDEO_TYPES.includes(file.type) || ext === "mov";
    };

    fileArray.forEach((file) => {
      if (!isImageFile(file)) return;
      const base = getBaseName(file.name);
      if (!photoIdByBase.has(base)) {
        photoIdByBase.set(base, crypto.randomUUID());
      }
    });

    const tasks: UploadTask[] = fileArray.map((file) => {
      const id = crypto.randomUUID();
      const base = getBaseName(file.name);
      const photoId = photoIdByBase.get(base);
      if (photoId && isImageFile(file)) {
        return { id, file, mediaType: "PHOTO", mediaRole: "image", photoId };
      }
      if (photoId && isLiveVideoFile(file)) {
        return { id, file, mediaType: "PHOTO", mediaRole: "liveVideo", photoId };
      }
      return { id, file, mediaType: "VIDEO" };
    });

    const queue: UploadState[] = tasks.map((task) => ({
      id: task.id,
      name: task.file.name,
      progress: 0,
      status: "pending",
    }));
    setItems(queue);
    setBusy(true);

    // Generate local previews (best-effort)
    tasks.forEach((task) => {
      createPreview(task.file).then((url) => {
        if (url) updateItem(task.id, { previewUrl: url });
      });
    });

    // Concurrent upload with limited concurrency
    const uploadQueue = [...tasks];
    const activeUploads: Promise<void>[] = [];

    const startNext = async (): Promise<void> => {
      if (uploadQueue.length === 0) return;

      const nextTask = uploadQueue.shift()!;
      const controller = new AbortController();
      abortControllersRef.current.set(nextTask.id, controller);
      try {
        await processFile(nextTask, controller.signal);
      } finally {
        abortControllersRef.current.delete(nextTask.id);
      }
      await startNext();
    };

    // Start up to MAX_CONCURRENCY parallel upload workers
    const workers = Math.min(MAX_CONCURRENCY, tasks.length);
    for (let i = 0; i < workers; i++) {
      activeUploads.push(startNext());
    }

    // Wait for all uploads to complete
    await Promise.all(activeUploads);

    setBusy(false);
    onUploaded?.();
    if (inputRef.current) inputRef.current.value = "";
  };
  const handleCancelItem = useCallback((id: string) => {
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
    }
  }, []);


  const listContent = items.length > 0 ? (
    <ul className="uploader__list">
      {items.map((item) => {
        const isActive = item.status === "uploading" || item.status === "hashing";
        return (
          <li key={item.id} className="uploader__item">
            <div className="uploader__thumb" aria-hidden="true">
              {item.previewUrl ? (
                <img src={item.previewUrl} alt="" loading="lazy" />
              ) : (
                <span>VIDEO</span>
              )}
            </div>
            <div className="uploader__details">
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
              <div className="muted uploader__status">
                {item.status === "hashing"
                  ? "Hashing..."
                  : item.status === "uploading"
                  ? `Uploading ${item.progress}%`
                  : item.status === "done"
                  ? "Done"
                  : item.status === "skipped"
                  ? item.message || "Skipped"
                  : item.status === "error"
                  ? item.message || "Failed"
                  : "Pending"}
              </div>
            </div>
            <div className="uploader__item-actions">
              {isActive ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cancel upload"
                  onClick={() => handleCancelItem(item.id)}
                >
                  ✕
                </button>
              ) : (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove"
                  onClick={() => removeItem(item.id)}
                >
                  ✕
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  ) : null;

  return (
    <div className={`uploader ${variant === "inline" ? "uploader--inline" : ""}`}>
      <div className="uploader__bar">
        <div className="uploader__actions">
          <button
            className="icon-button uploader__upload"
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            aria-label={busy ? "Uploading files" : "Upload files"}
            title={busy ? "Uploading files" : "Upload files"}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {busy ? "progress_activity" : "upload"}
            </span>
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.mov,.hevc,.jpg,.jpeg,.png,.heic,.heif,video/mp4,video/quicktime,video/hevc,image/jpeg,image/png,image/heic,image/heif"
          multiple
          style={{ display: "none" }}
          onChange={(e) => handleSelect(e.target.files)}
        />
      </div>

      {error ? <p className="pill pill--error">{error}</p> : null}
      {listContent
        ? listTargetId
          ? listHost
            ? createPortal(listContent, listHost)
            : null
          : listContent
        : null}
    </div>
  );
}
