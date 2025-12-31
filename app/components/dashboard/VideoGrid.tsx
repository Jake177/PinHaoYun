"use client";

import { useMemo, useState } from "react";

type VideoItem = {
  id: string;
  originalName?: string;
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
  status?: string;
  createdAt?: string;
  captureTime?: string;
  captureLocation?: string;
  captureLat?: number;
  captureLon?: number;
  deviceMake?: string;
  deviceModel?: string;
  deviceSoftware?: string;
  size?: number;
};

type VideoGridProps = {
  videos: VideoItem[];
  onRefresh?: () => void;
};

const formatSize = (value?: number) => {
  if (!value) return "";
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = value / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = value / 1024;
  return `${kb.toFixed(0)} KB`;
};

const formatDate = (value?: string) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

export default function VideoGrid({ videos, onRefresh }: VideoGridProps) {
  const [preview, setPreview] = useState<VideoItem | null>(null);

  const groups = useMemo(() => {
    const buckets: Record<string, VideoItem[]> = {};
    videos.forEach((vid) => {
      const dateStr = vid.captureTime || vid.createdAt || "";
      const date = Date.parse(dateStr) ? new Date(dateStr) : null;
      const key = date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
        : "unknown";
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(vid);
    });
    // Sort groups by key desc (unknown last)
    const sortedKeys = Object.keys(buckets).sort((a, b) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return b.localeCompare(a);
    });
    return sortedKeys.map((key) => ({ key, items: buckets[key] }));
  }, [videos]);

  const renderLabel = (key: string) => {
    if (key === "unknown") return "未知日期";
    const [y, m] = key.split("-");
    return `${y}年${Number(m)}月`;
  };

  return (
    <>
      {videos.length === 0 ? (
        <div className="empty-state">
          <p>还没有上传视频，点击上方“上传视频”开始吧。</p>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="video-group">
            <h3 className="video-group__title">{renderLabel(group.key)}</h3>
            <div className="video-grid">
              {group.items.map((video) => {
                const previewUrl = video.thumbnailUrl || video.originalUrl || "";
                return (
                  <article className="video-card" key={video.id}>
                    <div className="video-thumb">
                      {previewUrl ? (
                        <>
                          <video
                            src={previewUrl}
                            muted
                            preload="metadata"
                            onClick={() => setPreview(video)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && setPreview(video)
                            }
                            role="button"
                            tabIndex={0}
                            playsInline
                            poster={video.thumbnailUrl || video.originalUrl || undefined}
                          />
                          <span className="video-play">▶</span>
                        </>
                      ) : (
                        <div className="thumb-fallback">暂无预览</div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ))
      )}

      {preview ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__body">
            <header className="modal__header">
              <div>
                <p className="muted">预览</p>
                <h3 className="ellipsis">
                  {preview.originalName || preview.id}
                </h3>
              </div>
              <button
                type="button"
                className="pill"
                onClick={() => setPreview(null)}
              >
                关闭
              </button>
            </header>
            {preview.thumbnailUrl || preview.originalUrl ? (
              <video
                src={preview.thumbnailUrl || preview.originalUrl || ""}
                controls
                playsInline
                preload="metadata"
                poster={preview.thumbnailUrl || preview.originalUrl || undefined}
                style={{ width: "100%", maxHeight: "60vh" }}
              />
            ) : (
              <div className="empty-state">暂无预览</div>
            )}
            <div className="metadata-panel">
              <h4>属性</h4>
              <ul>
                <li>拍摄时间：{formatDate(preview.captureTime || preview.createdAt) || "未知"}</li>
                <li>文件大小：{formatSize(preview.size)}</li>
                <li>
                  设备：
                  {preview.deviceMake || preview.deviceModel
                    ? `${preview.deviceMake || ""} ${preview.deviceModel || ""}`.trim()
                    : "未知"}
                </li>
                <li>
                  软件版本：{preview.deviceSoftware || "未知"}
                </li>
                <li>
                  拍摄地点：
                  {preview.captureLocation ||
                    (preview.captureLat && preview.captureLon
                      ? `${preview.captureLat}, ${preview.captureLon}`
                      : "未知")}
                </li>
              </ul>
              {preview.originalUrl ? (
                <a
                  className="pill pill--primary"
                  href={preview.originalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  下载原视频
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
