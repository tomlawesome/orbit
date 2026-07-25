"use client";

import { Icon } from "@/components/icons";
import { PushNotificationControl } from "@/components/push-notification-control";
import type { HouseholdNotification } from "@/lib/notifications";
import type { WorkspaceSession } from "@/lib/preview-workspace";

interface NotificationCenterProps {
  notifications: HouseholdNotification[];
  onClose(): void;
  onOpenItem(notification: HouseholdNotification): void;
  onRead(notificationId: string): void;
  onDismiss(notificationId: string): void;
  onReadAll(): void;
  session: WorkspaceSession | null;
}

export function NotificationCenter({
  notifications,
  onClose,
  onOpenItem,
  onRead,
  onDismiss,
  onReadAll,
  session,
}: NotificationCenterProps) {
  const unreadCount = notifications.filter((notification) => !notification.read).length;

  return (
    <>
      <button className="editor-scrim" type="button" aria-label="Close notifications" onClick={onClose} />
      <aside className="notification-center" role="dialog" aria-modal="true" aria-labelledby="notifications-title">
        <header className="editor-header">
          <div><p>Keep ahead</p><h2 id="notifications-title">Notifications</h2></div>
          <button type="button" aria-label="Close notifications" onClick={onClose}>×</button>
        </header>
        <div className="notification-toolbar">
          <span>{unreadCount ? `${unreadCount} unread` : "You’re all caught up"}</span>
          {unreadCount > 0 && <button onClick={onReadAll}>Mark all read</button>}
        </div>
        {session && <PushNotificationControl session={session} />}
        <div className="notification-list">
          {notifications.map((notification) => (
            <article className={`${notification.read ? "read" : ""} notification-${notification.kind}`} key={notification.id}>
              <button className="notification-main" onClick={() => onOpenItem(notification)}>
                <span className="notification-symbol"><Icon name={notification.kind === "overdue" ? "clock" : "bell"} /></span>
                <span>
                  <strong>{notification.title}</strong>
                  <small>{notification.message}</small>
                </span>
                {!notification.read && <i />}
              </button>
              <footer>
                {!notification.read && <button onClick={() => onRead(notification.id)}>Mark read</button>}
                <button onClick={() => onDismiss(notification.id)}>Dismiss</button>
              </footer>
            </article>
          ))}
          {!notifications.length && (
            <div className="notification-empty">
              <span><Icon name="check" /></span>
              <h3>Nothing needs your attention</h3>
              <p>New reminders will appear here as scheduled dates approach.</p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
