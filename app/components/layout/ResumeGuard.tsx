"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const RESUME_EVENT = "app:resume";
const RESUME_DEBOUNCE_MS = 1000;

export default function ResumeGuard() {
  const router = useRouter();
  const lastResumeRef = useRef(0);

  useEffect(() => {
    const emitResume = () => {
      const now = Date.now();
      if (now - lastResumeRef.current < RESUME_DEBOUNCE_MS) return;
      lastResumeRef.current = now;
      window.dispatchEvent(new Event(RESUME_EVENT));
      router.refresh();
      document.querySelectorAll("video").forEach((video) => {
        try {
          video.pause();
        } catch {
          // ignore pause errors
        }
      });
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        emitResume();
      }
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        emitResume();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [router]);

  return null;
}
