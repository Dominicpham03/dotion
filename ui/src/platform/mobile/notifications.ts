// Android reminders through @capacitor/local-notifications. Everything is
// planned from the on-device store (lib/reminders.ts), so reminders work
// offline; they are rescheduled after every sync and when the app resumes.
import { App } from "@capacitor/app";
import { LocalNotifications } from "@capacitor/local-notifications";
import { DEFAULT_REMINDERS, planReminders } from "@/lib/reminders";
import type { CalendarEvent, Entry, NotificationPermission, NotificationsApi, ReminderSettings } from "../types";

const CHANNEL = "reminders";
const KEY = "reminders";
const ICON = { smallIcon: "ic_stat_dotion", iconColor: "#415A77" }; // res/drawable in the Android project

export interface ReminderSource {
  entries(): Entry[];
  events(start: string, end: string): Promise<CalendarEvent[]>;
  getState(k: string): string;
  setState(k: string, v: string): Promise<void>;
  onChanged(cb: () => void): void;
}

const perm = (s: string): NotificationPermission => (s === "granted" ? "granted" : s === "denied" ? "denied" : "prompt");

export function createNotifications(src: ReminderSource, ready: Promise<unknown>): NotificationsApi {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const getSettings = (): ReminderSettings => {
    try {
      return { ...DEFAULT_REMINDERS, ...(JSON.parse(src.getState(KEY) || "{}") as Partial<ReminderSettings>) };
    } catch {
      return DEFAULT_REMINDERS;
    }
  };

  async function reschedule(): Promise<number> {
    await ready;
    if ((await LocalNotifications.checkPermissions()).display !== "granted") return 0;
    const settings = getSettings();
    const now = new Date();
    let events: CalendarEvent[] = [];
    if (settings.events) {
      try {
        events = await src.events(now.toISOString(), new Date(now.getTime() + 3 * 86_400_000).toISOString());
      } catch {
        // no calendar: skip event reminders
      }
    }
    const plan = planReminders(src.entries(), events, settings, now);

    const pending = await LocalNotifications.getPending();
    const ours = pending.notifications.filter((n) => n.extra?.dotion);
    if (ours.length) await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) });
    if (plan.length) {
      await LocalNotifications.schedule({
        notifications: plan.map((r) => ({
          id: r.id,
          title: r.title,
          body: r.body,
          channelId: CHANNEL,
          ...ICON,
          extra: { dotion: true, route: r.route },
          schedule: r.daily ? { on: r.daily, allowWhileIdle: true } : { at: r.at, allowWhileIdle: true },
        })),
      });
    }
    return plan.length;
  }

  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void reschedule().catch(() => {}), 3000);
  };

  // Set up once: the channel, opening the right page on tap, and triggers.
  void ready.then(async () => {
    try {
      await LocalNotifications.createChannel({ id: CHANNEL, name: "Reminders", description: "Due dates, events and the daily nudge", importance: 4 });
      await LocalNotifications.addListener("localNotificationActionPerformed", (a) => {
        const route = a.notification.extra?.route;
        if (typeof route === "string") window.location.hash = "#" + route;
      });
      await App.addListener("resume", soon);
      src.onChanged(soon);
      soon();
    } catch {
      // not running inside the Android app (tests, browser preview)
    }
  });

  return {
    permission: async () => perm((await LocalNotifications.checkPermissions()).display),
    async request() {
      const r = perm((await LocalNotifications.requestPermissions()).display);
      if (r === "granted") await reschedule();
      return r;
    },
    getSettings,
    async setSettings(s) {
      await src.setState(KEY, JSON.stringify(s));
      await reschedule();
    },
    reschedule,
    async test() {
      await LocalNotifications.schedule({
        notifications: [{ id: 2, title: "Dotion reminders are on", body: "Due dates and events will show up like this.", channelId: CHANNEL, ...ICON, schedule: { at: new Date(Date.now() + 3000), allowWhileIdle: true } }],
      });
    },
  };
}
