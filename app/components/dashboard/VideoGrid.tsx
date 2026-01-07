"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import LocationEditorModal from "@/app/components/map/LocationEditorModal";

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
  captureAddress?: string;
  captureCity?: string;
  captureRegion?: string;
  captureCountry?: string;
  deviceMake?: string;
  deviceModel?: string;
  deviceSoftware?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  codec?: string;
  rotation?: number;
  captureAlt?: number;
  size?: number;
};

type VideoGridProps = {
  videos: VideoItem[];
  onRefresh?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onDelete?: (video: VideoItem) => Promise<void>;
  onUpdateLocation?: (
    videoId: string,
    data: {
      lat: number;
      lon: number;
      address: string;
      city?: string;
      region?: string;
      country?: string;
    },
  ) => Promise<void>;
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

const formatDuration = (value?: number) => {
  if (!value || Number.isNaN(value)) return "";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
};

const formatFps = (value?: number) => {
  if (!value || Number.isNaN(value)) return "";
  return `${value.toFixed(2)} fps`;
};

const formatBitrate = (value?: number) => {
  if (!value || Number.isNaN(value)) return "";
  const mbps = value / 1_000_000;
  return `${mbps.toFixed(2)} Mbps`;
};

export default function VideoGrid({
  videos,
  onRefresh,
  hasMore,
  loadingMore,
  onLoadMore,
  onDelete,
  onUpdateLocation,
}: VideoGridProps) {
  const [preview, setPreview] = useState<VideoItem | null>(null);
  const [showMeta, setShowMeta] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [sheetTranslate, setSheetTranslate] = useState(100);
  const [isSheetDragging, setIsSheetDragging] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showLocationEditor, setShowLocationEditor] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationSaving, setLocationSaving] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({
    startY: 0,
    startTranslate: 100,
    height: 1,
    currentTranslate: 100,
    moved: false,
  });

  const SHEET_TRANSLATE = {
    full: 0,
    half: 45,
    closed: 100,
  };

  // Infinite scroll observer
  useEffect(() => {
    if (!hasMore || !onLoadMore) return;

    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !loadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  useEffect(() => {
    // 每次切换预览，重置属性折叠状态
    setShowMeta(false);
    setShowDeleteConfirm(false);
    setShowLocationEditor(false);
    setDeleteError(null);
    setLocationError(null);
    setSheetTranslate(SHEET_TRANSLATE.closed);
    dragRef.current.currentTranslate = SHEET_TRANSLATE.closed;
  }, [previewKey]);

  const setTranslate = (value: number) => {
    dragRef.current.currentTranslate = value;
    setSheetTranslate(value);
  };

  const openSheet = () => {
    setShowMeta(true);
    setTranslate(SHEET_TRANSLATE.half);
  };

  const closeSheet = () => {
    setTranslate(SHEET_TRANSLATE.closed);
    setShowMeta(false);
  };

  const toggleSheet = () => {
    if (showMeta) {
      closeSheet();
    } else {
      openSheet();
    }
  };

  const snapSheet = (translate: number) => {
    if (translate > 70) {
      closeSheet();
      return;
    }
    setShowMeta(true);
    if (translate < 20) {
      setTranslate(SHEET_TRANSLATE.full);
    } else {
      setTranslate(SHEET_TRANSLATE.half);
    }
  };

  const handleSheetPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!showMeta) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    dragRef.current.startY = event.clientY;
    dragRef.current.startTranslate = sheetTranslate;
    dragRef.current.currentTranslate = sheetTranslate;
    dragRef.current.height = sheet.getBoundingClientRect().height || 1;
    dragRef.current.moved = false;
    setIsSheetDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSheetPointerMove = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!isSheetDragging) return;
    const delta = event.clientY - dragRef.current.startY;
    if (Math.abs(delta) > 4) {
      dragRef.current.moved = true;
    }
    const next =
      dragRef.current.startTranslate +
      (delta / dragRef.current.height) * 100;
    const clamped = Math.min(
      SHEET_TRANSLATE.closed,
      Math.max(SHEET_TRANSLATE.full, next),
    );
    setTranslate(clamped);
  };

  const handleSheetPointerUp = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!isSheetDragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsSheetDragging(false);
    snapSheet(dragRef.current.currentTranslate);
  };

  const handleSheetPointerCancel = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (!isSheetDragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsSheetDragging(false);
    snapSheet(dragRef.current.currentTranslate);
  };

  const handleSheetToggle = () => {
    if (!showMeta) return;
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    if (sheetTranslate <= 10) {
      setTranslate(SHEET_TRANSLATE.half);
    } else {
      setTranslate(SHEET_TRANSLATE.full);
    }
  };

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

  // 重置属性开关
  const handleClose = () => {
    setPreview(null);
    setShowMeta(false);
    setPreviewKey(null);
    setShowDeleteConfirm(false);
    setShowLocationEditor(false);
    setDeleteError(null);
    setLocationError(null);
  };

  const handleDeleteClick = () => {
    if (!onDelete || deleting) return;
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = async () => {
    if (!preview || !onDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(preview);
      handleClose();
    } catch (err: any) {
      setDeleteError(err?.message || "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const handleCancelDelete = () => {
    if (deleting) return;
    setShowDeleteConfirm(false);
    setDeleteError(null);
  };

  const handleEditLocation = () => {
    if (!preview || !onUpdateLocation) return;
    setLocationError(null);
    setShowLocationEditor(true);
  };

  const handleSaveLocation = async (draft: {
    lat: number;
    lon: number;
    address: string;
    city?: string;
    region?: string;
    country?: string;
  }) => {
    if (!preview || !onUpdateLocation || locationSaving) return;
    setLocationSaving(true);
    setLocationError(null);
    try {
      await onUpdateLocation(preview.id, draft);
      setPreview((prev) =>
        prev
          ? {
              ...prev,
              captureLat: draft.lat,
              captureLon: draft.lon,
              captureAddress: draft.address,
              captureCity: draft.city,
              captureRegion: draft.region,
              captureCountry: draft.country,
            }
          : prev,
      );
      setShowLocationEditor(false);
    } catch (err: any) {
      setLocationError(err?.message || "保存失败");
    } finally {
      setLocationSaving(false);
    }
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
                            onClick={() => {
                              setPreview(video);
                              setPreviewKey(video.originalUrl || video.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                setPreview(video);
                                setPreviewKey(video.originalUrl || video.id);
                              }
                            }}
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

      {/* Infinite scroll sentinel */}
      {videos.length > 0 && (
        <div ref={sentinelRef} className="load-more-sentinel">
          {loadingMore ? (
            <span className="pill">加载更多...</span>
          ) : hasMore ? (
            <button
              type="button"
              className="pill"
              onClick={onLoadMore}
            >
              加载更多
            </button>
          ) : (
            <span className="pill">已到底</span>
          )}
        </div>
      )}

      {preview ? (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          onClick={handleClose}
        >
          <div
            className="modal__body"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal__header">
              <div>
                <p className="muted">预览</p>
              </div>
              <button
                type="button"
                className="pill"
                onClick={handleClose}
              >
                关闭
              </button>
            </header>
            {preview.originalUrl ? (
              <video
                key={previewKey || preview.id}
                src={preview.originalUrl}
                controls
                playsInline
                preload="metadata"
                poster={preview.thumbnailUrl || undefined}
                className="preview-video"
              />
            ) : (
              <div className="empty-state">暂无预览</div>
            )}
            <div
              className={`metadata-toggle preview-actions ${
                showMeta ? "metadata-toggle--inactive" : ""
              }`}
            >
              <div className="preview-actions__bar">
                <button
                  type="button"
                  className="pill pill--icon"
                  onClick={toggleSheet}
                  aria-label={showMeta ? "收起属性" : "查看属性"}
                  aria-pressed={showMeta}
                  title={showMeta ? "收起属性" : "查看属性"}
                >
                  <span className="material-symbols-outlined">info</span>
                </button>
                <button
                  type="button"
                  className="pill pill--icon"
                  onClick={handleEditLocation}
                  disabled={!onUpdateLocation}
                  aria-label="编辑位置"
                  title="编辑位置"
                >
                  <span className="material-symbols-outlined">map_search</span>
                </button>
                <button
                  type="button"
                  className="pill pill--icon pill--danger"
                  onClick={handleDeleteClick}
                  disabled={deleting || !onDelete}
                  aria-label={deleting ? "删除中..." : "删除"}
                  title={deleting ? "删除中..." : "删除"}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
                {preview.originalUrl ? (
                  <a
                    className="pill pill--icon pill--primary"
                    href={preview.originalUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="下载"
                    title="下载"
                  >
                    <span className="material-symbols-outlined">download</span>
                  </a>
                ) : null}
              </div>
            </div>
            {deleteError ? (
              <p className="pill pill--error" style={{ marginTop: "0.75rem" }}>
                {deleteError}
              </p>
            ) : null}
            <div
              ref={sheetRef}
              className={`metadata-panel ${showMeta ? "metadata-panel--open" : ""} ${
                isSheetDragging ? "metadata-panel--dragging" : ""
              }`}
              aria-expanded={showMeta}
              style={
                {
                  "--sheet-translate": `${sheetTranslate}%`,
                } as React.CSSProperties
              }
            >
              <div className="metadata-sheet__header">
                <button
                  type="button"
                  className="metadata-sheet__handle"
                  onClick={handleSheetToggle}
                  onPointerDown={handleSheetPointerDown}
                  onPointerMove={handleSheetPointerMove}
                  onPointerUp={handleSheetPointerUp}
                  onPointerCancel={handleSheetPointerCancel}
                  aria-label="切换属性高度"
                >
                  <span />
                </button>
                <span className="metadata-sheet__title">属性</span>
                <button
                  type="button"
                  className="metadata-sheet__close"
                  onClick={closeSheet}
                  aria-label="关闭属性"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <ul>
                <li>拍摄时间：{formatDate(preview.captureTime || preview.createdAt) || "未知"}</li>
                <li>文件大小：{formatSize(preview.size)}</li>
                <li>时长：{formatDuration(preview.durationSec) || "未知"}</li>
                <li>
                  分辨率：
                  {preview.width && preview.height
                    ? `${preview.width} × ${preview.height}`
                    : "未知"}
                </li>
                <li>帧率：{formatFps(preview.fps) || "未知"}</li>
                <li>编码：{preview.codec || "未知"}</li>
                <li>码率：{formatBitrate(preview.bitrate) || "未知"}</li>
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
                  {preview.captureAddress ||
                    (preview.captureLat != null && preview.captureLon != null
                      ? `${preview.captureLat}, ${preview.captureLon}`
                      : "未知")}
                </li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}
      {showDeleteConfirm ? (
        <div
          className="confirm-modal"
          role="alertdialog"
          aria-modal="true"
          onClick={handleCancelDelete}
        >
          <div
            className="confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="confirm-dialog__title">确认删除</h3>
            <p className="confirm-dialog__text">删除后无法恢复。</p>
            {deleteError ? (
              <p className="pill pill--error">{deleteError}</p>
            ) : null}
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="pill"
                onClick={handleCancelDelete}
                disabled={deleting}
              >
                取消
              </button>
              <button
                type="button"
                className="pill pill--error"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showLocationEditor && preview ? (
        <LocationEditorModal
          initialLat={preview.captureLat}
          initialLon={preview.captureLon}
          initialAddress={preview.captureAddress}
          onClose={() => setShowLocationEditor(false)}
          onSave={handleSaveLocation}
          saving={locationSaving}
          error={locationError}
        />
      ) : null}
    </>
  );
}
