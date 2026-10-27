/**
 * Navigation pending indicator for app routes.
 *
 * Shows a subtle loading indicator when client-side navigation is in progress.
 * Uses React Router's useNavigation() to detect loading/submitting states.
 * Includes a short delay before showing to avoid flashing on fast navigations.
 * Respects prefers-reduced-motion for accessibility.
 */
import { useNavigation } from "react-router";
import { useState, useEffect } from "react";

const SHOW_DELAY_MS = 200;

const INDICATOR_STYLES = `
  @keyframes nav-indicator-progress {
    0% { width: 0%; }
    50% { width: 70%; }
    100% { width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .nav-indicator-bar {
      animation: none !important;
      width: 100% !important;
    }
  }
`;

export function NavigationIndicator() {
  const navigation = useNavigation();
  const [showIndicator, setShowIndicator] = useState(false);

  const isNavigating = navigation.state !== "idle";

  useEffect(() => {
    if (isNavigating) {
      const timer = setTimeout(() => {
        setShowIndicator(true);
      }, SHOW_DELAY_MS);
      return () => clearTimeout(timer);
    } else {
      setShowIndicator(false);
    }
  }, [isNavigating]);

  if (!showIndicator) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "3px",
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      <div
        className="nav-indicator-bar"
        style={{
          height: "100%",
          background: "var(--p-color-bg-fill-brand, #303030)",
          animation: "nav-indicator-progress 2s ease-in-out infinite",
        }}
      />
      <style>{INDICATOR_STYLES}</style>
    </div>
  );
}
