"use client";

import { useState } from "react";

type VideoItem = {
  id: string;
  originalName?: string;
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
  status?: string;
  createdAt?: string;
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

export default function VideoGrid({ videos, onRefresh }: VideoGridProps) {
  const [preview, setPreview] = useState<VideoItem | null>(null);

  return (
    <>
      <div className="video-grid">
        {videos.length === 0 ? (
          <div className="empty-state">
            <p>还没有上传视频，点击上方“上传视频”开始吧。</p>
          </div>
        ) : (
          videos.map((video) => (
            <article className="video-card" key={video.id}>
              <div
                className="video-thumb"
                role="button"
                tabIndex={0}
                onClick={() => setPreview(video)}
                onKeyDown={(e) => e.key === "Enter" && setPreview(video)}
              >
                {video.thumbnailUrl ? (
                  <video src={video.thumbnailUrl} muted preload="metadata" />
                ) : (
                  <div className="thumb-fallback">预览生成中</div>
                )}
              </div>
              <div className="video-meta">
                <p className="ellipsis">{video.originalName || video.id}</p>
                <div className="meta-row">
                  <span className="pill">{video.status || "未知"}</span>
                  <span className="muted">{formatSize(video.size)}</span>
                </div>
              </div>
              <div className="video-actions">
                <button
                  type="button"
                  className="pill"
                  onClick={() => setPreview(video)}
                  disabled={!video.thumbnailUrl}
                >
                  播放
                </button>
                <a
                  className="pill pill--primary"
                  href={video.originalUrl || undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  下载原视频
                </a>
              </div>
            </article>
          ))
        )}
      </div>

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
            {preview.thumbnailUrl ? (
              <video
                src={preview.thumbnailUrl}
                controls
                preload="metadata"
                style={{ width: "100%", maxHeight: "60vh" }}
              />
            ) : (
              <div className="empty-state">预览生成中...</div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
