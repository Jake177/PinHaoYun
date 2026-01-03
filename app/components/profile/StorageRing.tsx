"use client";

type StorageRingProps = {
  usedBytes: number;
  quotaBytes: number;
  size?: number; // SVG size in pixels
  strokeWidth?: number;
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
};

export default function StorageRing({
  usedBytes,
  quotaBytes,
  size = 120,
  strokeWidth = 10,
}: StorageRingProps) {
  const percentage = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0;

  // Determine color based on percentage
  let strokeColor: string;
  let bgColor: string;
  if (percentage < 65) {
    strokeColor = "#16a34a"; // Green
    bgColor = "rgba(22, 163, 74, 0.15)";
  } else if (percentage < 90) {
    strokeColor = "#eab308"; // Yellow
    bgColor = "rgba(234, 179, 8, 0.15)";
  } else {
    strokeColor = "#dc2626"; // Red
    bgColor = "rgba(220, 38, 38, 0.15)";
  }

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;
  const center = size / 2;

  return (
    <div className="storage-ring">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="storage-ring__svg"
      >
        {/* Background circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={bgColor}
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.3s ease" }}
        />
      </svg>
      <div className="storage-ring__content">
        <div className="storage-ring__percentage" style={{ color: strokeColor }}>
          {percentage.toFixed(1)}%
        </div>
        <div className="storage-ring__label">已使用</div>
      </div>
      <div className="storage-ring__details">
        <span className="storage-ring__used">{formatBytes(usedBytes)}</span>
        <span className="storage-ring__separator">/</span>
        <span className="storage-ring__quota">{formatBytes(quotaBytes)}</span>
      </div>
    </div>
  );
}
