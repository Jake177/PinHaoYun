"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LocationEditorModal from "@/app/components/map/LocationEditorModal";

type VideoItem = {
  id: string;
  type?: "VIDEO" | "PHOTO";
  originalName?: string;
  thumbnailUrl?: string | null;
  thumbnailUrlAlt?: string | null;
  originalUrl?: string | null;
  originalPhotoUrl?: string | null;
  liveVideoUrl?: string | null;
  liveVideoSize?: number;
  status?: string;
  createdAt?: string;
  captureTime?: string;
  fileLastModified?: string;
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
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (videoId: string) => void;
  onUpdateLocation?: (
    mediaId: string,
    data: {
      lat: number;
      lon: number;
      address: string;
      city?: string;
      region?: string;
      country?: string;
    },
    mediaType?: "VIDEO" | "PHOTO",
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
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB");
};

const formatDuration = (value?: number) => {
  if (!value || Number.isNaN(value)) return "";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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

const isHeicLike = (name?: string) => {
  const lower = (name || "").toLowerCase();
  return lower.endsWith(".heic") || lower.endsWith(".heif");
};

export default function VideoGrid({
  videos,
  onRefresh,
  hasMore,
  loadingMore,
  onLoadMore,
  onDelete,
  selectionMode,
  selectedIds,
  onToggleSelect,
  onUpdateLocation,
}: VideoGridProps) {
  const [preview, setPreview] = useState<VideoItem | null>(null);
  const [showMeta, setShowMeta] = useState(true);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showLocationEditor, setShowLocationEditor] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationSaving, setLocationSaving] = useState(false);
  const [isPlayingLive, setIsPlayingLive] = useState(false);
  const liveVideoRef = useRef<HTMLVideoElement>(null);

  const previewIsHeicPhoto =
    preview?.type === "PHOTO" && isHeicLike(preview.originalName);
  // For photos: prefer originalPhotoUrl (HEIC/original format) for preview
  // Fall back to thumbnail if original is not available
  const previewPhotoSrc =
    preview?.type === "PHOTO"
      ? preview?.originalPhotoUrl ||
        preview?.thumbnailUrl ||
        preview?.thumbnailUrlAlt ||
        (preview?.originalUrl && !previewIsHeicPhoto ? preview.originalUrl : null)
      : null;
  const hasPreviewMedia =
    preview?.type === "PHOTO"
      ? Boolean(preview?.liveVideoUrl || previewPhotoSrc)
      : Boolean(preview?.originalUrl);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreInFlightRef = useRef(false);

  const toggleDetails = () => {
    setShowMeta((prev) => !prev);
  };

  // Live Photo long-press handlers
  const handleLivePhotoStart = useCallback(() => {
    if (!liveVideoRef.current) return;
    setIsPlayingLive(true);
    liveVideoRef.current.currentTime = 0;
    liveVideoRef.current.play().catch(() => {
      // Autoplay may be blocked, ignore
    });
  }, []);

  const handleLivePhotoEnd = useCallback(() => {
    if (!liveVideoRef.current) return;
    setIsPlayingLive(false);
    liveVideoRef.current.pause();
    liveVideoRef.current.currentTime = 0;
  }, []);

  // Reset live photo state when preview changes
  useEffect(() => {
    setIsPlayingLive(false);
  }, [previewKey]);

  const handleLoadMore = useCallback(() => {
    if (!onLoadMore || !hasMore) return;
    if (loadingMore || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    onLoadMore();
  }, [hasMore, loadingMore, onLoadMore]);

  useEffect(() => {
    if (!loadingMore) {
      loadMoreInFlightRef.current = false;
    }
  }, [loadingMore]);

  // Infinite scroll observer
  useEffect(() => {
    if (!hasMore || !onLoadMore || loadingMore) return;

    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadMoreInFlightRef.current) {
          // Debounce the callback
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            handleLoadMore();
          }, 150);
        }
      },
      { rootMargin: "200px", threshold: 0 }
    );

    observer.observe(sentinel);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      observer.disconnect();
    };
  }, [handleLoadMore, hasMore, onLoadMore]);

  useEffect(() => {
    // When preview changes, reset states
    if (preview) {
      setShowMeta(false);
      setShowDeleteConfirm(false);
      setShowLocationEditor(false);
      setDeleteError(null);
      setLocationError(null);
    } else {
      setShowMeta(false);
      setShowDeleteConfirm(false);
      setShowLocationEditor(false);
      setDeleteError(null);
      setLocationError(null);
    }
  }, [previewKey]);

  const groups = useMemo(() => {
    const buckets: Record<string, VideoItem[]> = {};
    videos.forEach((vid) => {
      // Use captureTime first, then fileLastModified, then createdAt
      const dateStr = vid.captureTime || vid.fileLastModified || vid.createdAt || "";
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
    if (key === "unknown") return "Unknown date";
    const [y, m] = key.split("-");
    const monthIndex = Number(m) - 1;
    if (!Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) return key;
    const date = new Date(Number(y), monthIndex, 1);
    return date.toLocaleString("en-GB", { month: "long", year: "numeric" });
  };

  // Reset metadata sheet state.
  const handleClose = useCallback(() => {
    setPreview(null);
    setShowMeta(false);
    setPreviewKey(null);
    setShowDeleteConfirm(false);
    setShowLocationEditor(false);
    setDeleteError(null);
    setLocationError(null);
  }, []);

  useEffect(() => {
    const handleResume = () => {
      handleClose();
    };

    window.addEventListener("app:resume", handleResume);
    return () => window.removeEventListener("app:resume", handleResume);
  }, [handleClose]);

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
      setDeleteError(err?.message || "Delete failed.");
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
      await onUpdateLocation(preview.id, draft, preview.type || "VIDEO");
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
      setLocationError(err?.message || "Save failed.");
    } finally {
      setLocationSaving(false);
    }
  };

  return (
    <>
      {videos.length === 0 ? (
        <div className="empty-state">
          <p>No items yet. Use the upload button to add photos or videos.</p>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="video-group">
            <h3 className="video-group__title">{renderLabel(group.key)}</h3>
            <div className="video-grid">
                {group.items.map((video) => {
                  const isPhoto = video.type === "PHOTO";
                  const isHeicPhoto = isPhoto && isHeicLike(video.originalName);
                  const previewUrl =
                    video.thumbnailUrl ||
                    video.thumbnailUrlAlt ||
                    (!isHeicPhoto ? video.originalUrl : null) ||
                    "";
                const hasLiveVideo = Boolean(video.liveVideoUrl);
                const isSelecting = Boolean(selectionMode && onToggleSelect);
                const isSelected = Boolean(isSelecting && selectedIds?.has(video.id));
                const handleSelect = () => {
                  if (!isSelecting) return;
                  onToggleSelect?.(video.id);
                };
                const handlePreviewClick = () => {
                  if (isSelecting) {
                    handleSelect();
                    return;
                  }
                  setPreview(video);
                  setPreviewKey(video.originalUrl || video.id);
                };
                return (
                  <article
                    className={`video-card ${isSelected ? "video-card--selected" : ""} ${
                      isSelecting ? "video-card--selecting" : ""
                    }`}
                    key={video.id}
                  >
                    {isSelecting ? (
                      <button
                        type="button"
                        className={`video-select ${isSelected ? "video-select--active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleSelect();
                        }}
                        aria-label={isSelected ? "Deselect video" : "Select video"}
                      >
                        <span className="material-symbols-outlined">
                          {isSelected ? "check_circle" : "radio_button_unchecked"}
                        </span>
                      </button>
                    ) : null}
                    <div
                      className="video-thumb"
                      role="button"
                      tabIndex={0}
                      onClick={handlePreviewClick}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handlePreviewClick();
                        }
                      }}
                      aria-label={isSelecting ? "Select item" : "Open preview"}
                    >
                      {previewUrl ? (
                        <>
                          {isPhoto ? (
                            <img
                              src={previewUrl}
                              data-alt-src={video.thumbnailUrlAlt || undefined}
                              alt=""
                              loading="lazy"
                              onError={(e) => {
                                const img = e.currentTarget;
                                const altSrc = img.dataset.altSrc;
                                if (altSrc && img.src !== altSrc) {
                                  img.src = altSrc;
                                }
                              }}
                            />
                          ) : (
                            <video
                              src={previewUrl}
                              muted
                              preload="metadata"
                              playsInline
                              poster={video.thumbnailUrl || video.originalUrl || undefined}
                            />
                          )}
                          {!isPhoto ? <span className="video-play">▶</span> : null}
                          {isPhoto && hasLiveVideo ? (
                            <span className="video-live">LIVE</span>
                          ) : null}
                          {/* Show location_off icon if no coordinates */}
                          {video.captureLat == null || video.captureLon == null ? (
                            <span className="location-missing" title="No location data">
                              <span className="material-symbols-outlined">location_off</span>
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <div className="thumb-fallback">No preview</div>
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
            <span className="pill">Loading more...</span>
          ) : hasMore ? (
            <button
              type="button"
              className="pill"
              onClick={handleLoadMore}
            >
              Load more
            </button>
          ) : (
            <span className="pill">End of list</span>
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
                <p className="muted">Preview</p>
              </div>
              <button
                type="button"
                className="pill"
                onClick={handleClose}
              >
                Close
              </button>
            </header>
            {hasPreviewMedia ? (
              <div className="preview-media-wrapper">
                {preview.type === "PHOTO" ? (
                  <div className="preview-container">
                    {preview.liveVideoUrl ? (
                      // For Live Photos: long-press to play
                      <div
                        className="live-photo-wrapper"
                        onPointerDown={handleLivePhotoStart}
                        onPointerUp={handleLivePhotoEnd}
                        onPointerLeave={handleLivePhotoEnd}
                        onPointerCancel={handleLivePhotoEnd}
                        onContextMenu={(e) => e.preventDefault()}
                      >
                        <img
                          src={previewPhotoSrc || ""}
                          data-alt-src={preview.thumbnailUrlAlt || undefined}
                          alt={preview.originalName || "Photo"}
                          className={`preview-image live-photo-image ${isPlayingLive ? "live-photo-image--hidden" : ""}`}
                          draggable={false}
                          onError={(e) => {
                            const img = e.currentTarget;
                            const altSrc = img.dataset.altSrc;
                            if (altSrc && img.src !== altSrc) {
                              img.src = altSrc;
                            }
                          }}
                        />
                        <video
                          ref={liveVideoRef}
                          src={preview.liveVideoUrl}
                          className={`preview-video live-photo-video ${isPlayingLive ? "live-photo-video--visible" : ""}`}
                          muted
                          playsInline
                          loop
                          preload="auto"
                          onEnded={handleLivePhotoEnd}
                        />
                        <div className={`live-photo-badge ${isPlayingLive ? "live-photo-badge--playing" : ""}`}>
                          <span className="material-symbols-outlined">motion_photos_on</span>
                          <span className="live-photo-badge__text">
                            {isPlayingLive ? "Playing..." : "Hold to play"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <img
                        src={previewPhotoSrc || ""}
                        data-alt-src={preview.thumbnailUrlAlt || undefined}
                        alt={preview.originalName || "Photo"}
                        className="preview-image"
                        onError={(e) => {
                          const img = e.currentTarget;
                          const altSrc = img.dataset.altSrc;
                          if (altSrc && img.src !== altSrc) {
                            img.src = altSrc;
                          }
                        }}
                      />
                    )}
                  </div>
                ) : (
                  <video
                    key={previewKey || preview.id}
                    src={preview.originalUrl || undefined}
                    controls
                    playsInline
                    preload="metadata"
                    poster={preview.thumbnailUrl || preview.thumbnailUrlAlt || undefined}
                    className="preview-video"
                  />
                )}
                {/* Overlay details panel */}
                <div
                  className={`preview-details ${showMeta ? "preview-details--open" : ""}`}
                  aria-expanded={showMeta}
                >
                  <ul className="preview-details__list">
                    <li>
                      <span className="detail-label">Captured</span>
                      <span className="detail-value">{formatDate(preview.captureTime || preview.createdAt) || "Unknown"}</span>
                    </li>
                    <li>
                      <span className="detail-label">File size</span>
                      <span className="detail-value">{formatSize(preview.size) || "Unknown"}</span>
                    </li>
                    {preview.type !== "PHOTO" ? (
                      <>
                        <li>
                          <span className="detail-label">Duration</span>
                          <span className="detail-value">{formatDuration(preview.durationSec) || "Unknown"}</span>
                        </li>
                        <li>
                          <span className="detail-label">Resolution</span>
                          <span className="detail-value">
                            {preview.width && preview.height
                              ? `${preview.width} × ${preview.height}`
                              : "Unknown"}
                          </span>
                        </li>
                        <li>
                          <span className="detail-label">Frame rate</span>
                          <span className="detail-value">{formatFps(preview.fps) || "Unknown"}</span>
                        </li>
                        <li>
                          <span className="detail-label">Codec</span>
                          <span className="detail-value">{preview.codec || "Unknown"}</span>
                        </li>
                        <li>
                          <span className="detail-label">Bitrate</span>
                          <span className="detail-value">{formatBitrate(preview.bitrate) || "Unknown"}</span>
                        </li>
                      </>
                    ) : (
                      <li>
                        <span className="detail-label">Resolution</span>
                        <span className="detail-value">
                          {preview.width && preview.height
                            ? `${preview.width} × ${preview.height}`
                            : "Unknown"}
                        </span>
                      </li>
                    )}
                    <li>
                      <span className="detail-label">Device</span>
                      <span className="detail-value">
                        {preview.deviceMake || preview.deviceModel
                          ? `${preview.deviceMake || ""} ${preview.deviceModel || ""}`.trim()
                          : "Unknown"}
                      </span>
                    </li>
                    <li>
                      <span className="detail-label">Software</span>
                      <span className="detail-value">{preview.deviceSoftware || "Unknown"}</span>
                    </li>
                    <li>
                      <span className="detail-label">Location</span>
                      <span className="detail-value">
                        {preview.captureAddress ||
                          (preview.captureLat != null && preview.captureLon != null
                            ? `${preview.captureLat.toFixed(6)}, ${preview.captureLon.toFixed(6)}`
                            : "Unknown")}
                      </span>
                    </li>
                  </ul>
                </div>
              </div>
            ) : (
              <div className="empty-state">No preview available</div>
            )}
            {/* Action buttons */}
            <div className="preview-actions">
              <div className="preview-actions__bar">
                <button
                  type="button"
                  className={`pill pill--icon ${showMeta ? "pill--active" : ""}`}
                  onClick={toggleDetails}
                  aria-label={showMeta ? "Hide details" : "Show details"}
                  aria-pressed={showMeta}
                  title={showMeta ? "Hide details" : "Show details"}
                >
                  <span className="material-symbols-outlined">info</span>
                </button>
                <button
                  type="button"
                  className="pill pill--icon"
                  onClick={handleEditLocation}
                  disabled={!onUpdateLocation}
                  aria-label="Edit location"
                  title="Edit location"
                >
                  <span className="material-symbols-outlined">map_search</span>
                </button>
                <button
                  type="button"
                  className="pill pill--icon pill--danger"
                  onClick={handleDeleteClick}
                  disabled={deleting || !onDelete}
                  aria-label={deleting ? "Deleting..." : "Delete"}
                  title={deleting ? "Deleting..." : "Delete"}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
                {preview.originalUrl ? (
                  <a
                    className="pill pill--icon pill--primary"
                    href={preview.originalUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Download"
                    title="Download"
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
            <h3 className="confirm-dialog__title">Confirm deletion</h3>
            <p className="confirm-dialog__text">This cannot be undone.</p>
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
                Cancel
              </button>
              <button
                type="button"
                className="pill pill--error"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Confirm"}
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
