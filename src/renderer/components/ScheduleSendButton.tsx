import { useState, useRef, useEffect, useMemo } from "react";

interface ScheduleSendButtonProps {
  onSchedule: (scheduledAt: number) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Superhuman-style schedule send button with quick presets and custom date/time picker.
 */
export function ScheduleSendButton({ onSchedule, disabled, className }: ScheduleSendButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("09:00");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setShowCustom(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setShowCustom(false);
      }
    };
    if (isOpen) {
      document.addEventListener("keydown", handleKey);
      return () => document.removeEventListener("keydown", handleKey);
    }
  }, [isOpen]);

  const presets = useMemo(() => getSchedulePresets(), [isOpen]);

  const handlePreset = (timestamp: number) => {
    onSchedule(timestamp);
    setIsOpen(false);
  };

  const handleCustomSubmit = () => {
    if (!customDate || !customTime) return;
    const dt = new Date(`${customDate}T${customTime}`);
    if (dt.getTime() <= Date.now()) return;
    onSchedule(dt.getTime());
    setIsOpen(false);
    setShowCustom(false);
  };

  // Set default custom date to tomorrow
  useEffect(() => {
    if (showCustom && !customDate) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setCustomDate(tomorrow.toISOString().split("T")[0]);
    }
  }, [showCustom, customDate]);

  return (
    <div className={`relative ${className || ""}`} ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors"
        title="Schedule send"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>Schedule</span>
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute bottom-full mb-2 right-0 w-72 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50 overflow-hidden">
          {!showCustom ? (
            <>
              <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Schedule Send
                </p>
              </div>
              <div className="py-1">
                {presets.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => handlePreset(preset.timestamp)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                  >
                    <span className="text-gray-900 dark:text-gray-100">{preset.label}</span>
                    <span className="text-gray-400 dark:text-gray-500 text-xs">
                      {preset.description}
                    </span>
                  </button>
                ))}
              </div>
              <div className="border-t border-gray-100 dark:border-gray-700 py-1">
                <button
                  onClick={() => setShowCustom(true)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <svg
                    className="w-4 h-4 text-gray-400 dark:text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                  <span>Pick date & time</span>
                </button>
              </div>
            </>
          ) : (
            <div className="p-3 space-y-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowCustom(false)}
                  className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Custom date & time
                </p>
              </div>
              <div className="space-y-2">
                <input
                  type="date"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  min={new Date().toISOString().split("T")[0]}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="time"
                  value={customTime}
                  onChange={(e) => setCustomTime(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                onClick={handleCustomSubmit}
                disabled={!customDate || !customTime}
                className="w-full px-3 py-2 text-sm font-medium text-white bg-blue-600 dark:bg-blue-500 rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors"
              >
                Schedule
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Compute Superhuman-style schedule presets based on current time.
 */
function getSchedulePresets(): Array<{ label: string; description: string; timestamp: number }> {
  const now = new Date();
  const presets: Array<{ label: string; description: string; timestamp: number }> = [];

  const currentHour = now.getHours();

  // "Later today" - 2 hours from now (only if before 8pm)
  if (currentHour < 20) {
    const laterToday = new Date(now);
    laterToday.setHours(laterToday.getHours() + 2, 0, 0, 0);
    presets.push({
      label: "Later today",
      description: formatTime(laterToday),
      timestamp: laterToday.getTime(),
    });
  }

  // "This evening" - 6pm today (only if before 6pm)
  if (currentHour < 18) {
    const thisEvening = new Date(now);
    thisEvening.setHours(18, 0, 0, 0);
    presets.push({
      label: "This evening",
      description: formatTime(thisEvening),
      timestamp: thisEvening.getTime(),
    });
  }

  // "Tomorrow morning" - 8am tomorrow
  const tomorrowMorning = new Date(now);
  tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
  tomorrowMorning.setHours(8, 0, 0, 0);
  presets.push({
    label: "Tomorrow morning",
    description: formatDateShort(tomorrowMorning) + ", " + formatTime(tomorrowMorning),
    timestamp: tomorrowMorning.getTime(),
  });

  // "Tomorrow afternoon" - 1pm tomorrow
  const tomorrowAfternoon = new Date(now);
  tomorrowAfternoon.setDate(tomorrowAfternoon.getDate() + 1);
  tomorrowAfternoon.setHours(13, 0, 0, 0);
  presets.push({
    label: "Tomorrow afternoon",
    description: formatDateShort(tomorrowAfternoon) + ", " + formatTime(tomorrowAfternoon),
    timestamp: tomorrowAfternoon.getTime(),
  });

  // "Next Monday morning" - if today is not Monday, show next Monday at 8am
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : 8 - dayOfWeek;
  if (daysUntilMonday <= 6) {
    const nextMonday = new Date(now);
    nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
    nextMonday.setHours(8, 0, 0, 0);
    presets.push({
      label: dayOfWeek >= 2 && dayOfWeek <= 5 ? "Next Monday" : "Monday morning",
      description: formatDateShort(nextMonday) + ", " + formatTime(nextMonday),
      timestamp: nextMonday.getTime(),
    });
  }

  // "Next week" - 7 days from now at 8am
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  nextWeek.setHours(8, 0, 0, 0);
  presets.push({
    label: "In one week",
    description: formatDateShort(nextWeek) + ", " + formatTime(nextWeek),
    timestamp: nextWeek.getTime(),
  });

  return presets;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDateShort(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Inline scheduled messages list shown below compose areas.
 */
export function ScheduledMessagesList({ accountId }: { accountId: string }) {
  const [messages, setMessages] = useState<
    Array<{
      id: string;
      to: string[];
      subject: string;
      scheduledAt: number;
      status: string;
    }>
  >([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadMessages = async () => {
    try {
      // Scope to 'scheduled': undo-send rows share this table but belong to the
      // toast, not this dropdown.
      const result = await window.api.scheduledSend.list(accountId, "scheduled");
      if (result.success) {
        setMessages(result.data);
      }
    } catch (e) {
      console.error("Failed to load scheduled messages:", e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMessages();

    // Listen for stats changes to refresh
    window.api.scheduledSend.onStatsChanged(() => {
      loadMessages();
    });

    return () => {
      window.api.scheduledSend.removeAllListeners();
    };
  }, [accountId]);

  const handleCancel = async (id: string) => {
    try {
      await window.api.scheduledSend.cancel(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      console.error("Failed to cancel scheduled message:", e);
    }
  };

  if (isLoading || messages.length === 0) return null;

  return (
    <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Scheduled ({messages.length})
        </p>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
        {messages.map((msg) => (
          <div key={msg.id} className="flex items-center justify-between px-3 py-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                {msg.subject || "(no subject)"}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                To {msg.to.join(", ")} &middot; {formatScheduledTime(msg.scheduledAt)}
              </p>
            </div>
            <button
              onClick={() => handleCancel(msg.id)}
              className="ml-2 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatScheduledTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if (isToday) return `Today at ${time}`;
  if (isTomorrow) return `Tomorrow at ${time}`;
  return (
    date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) +
    ` at ${time}`
  );
}
