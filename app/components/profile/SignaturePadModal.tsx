"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type Point = { x: number; y: number };

type SignaturePadModalProps = {
  onClose: () => void;
  onAdd: (dataUrl: string) => void;
};

const PAD_HEIGHT = 220;

export default function SignaturePadModal({ onClose, onAdd }: SignaturePadModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<Point | null>(null);
  const [hasInk, setHasInk] = useState(false);

  const resetCanvas = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const width = Math.max(260, Math.floor(container.clientWidth));
    const height = PAD_HEIGHT;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0f172a";
    ctx.fillStyle = "#0f172a";

    drawingRef.current = false;
    lastPointRef.current = null;
    setHasInk(false);
  }, []);

  useEffect(() => {
    resetCanvas();

    const handleResize = () => {
      resetCanvas();
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [resetCanvas]);

  const pointFromEvent = (e: ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const point = pointFromEvent(e);
    if (!canvas || !point) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastPointRef.current = point;

    // Draw a dot so taps without movement still produce a signature mark.
    ctx.beginPath();
    ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    setHasInk(true);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;

    const canvas = canvasRef.current;
    const point = pointFromEvent(e);
    const lastPoint = lastPointRef.current;
    if (!canvas || !point || !lastPoint) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    e.preventDefault();
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    setHasInk(true);
  };

  const stopDrawing = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    drawingRef.current = false;
    lastPointRef.current = null;
  };

  const handleAdd = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    const dataUrl = canvas.toDataURL("image/png");
    onAdd(dataUrl);
  };

  return (
    <div className="signature-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="signature-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="signature-dialog__header">
          <h3>Add Signature</h3>
        </header>
        <div className="signature-dialog__body" ref={containerRef}>
          <canvas
            ref={canvasRef}
            className="signature-pad"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDrawing}
            onPointerLeave={stopDrawing}
            onPointerCancel={stopDrawing}
          />
          <p className="muted signature-dialog__hint">
            Use finger, stylus, mouse, or trackpad to sign.
          </p>
        </div>
        <div className="signature-dialog__actions">
          <button type="button" className="pill" onClick={onClose}>
            Back
          </button>
          <button type="button" className="pill" onClick={resetCanvas}>
            Clear
          </button>
          <button
            type="button"
            className="pill pill--primary"
            onClick={handleAdd}
            disabled={!hasInk}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
