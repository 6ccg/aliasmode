//! In-memory link identities. Equal URLs are separate requests, and stale actions
//! may never consume the next request. Kept independent of the window runtime.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingUrl {
    pub id: u64,
    pub url: String,
}

#[derive(Default)]
pub struct UrlQueue {
    pending: Vec<PendingUrl>,
    next_id: u64,
    // Covers first render and final acknowledgement, even without a snapshot.
    routing: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    Dismiss(u64),
    WaitForFrontend,
    CloseDashboard,
}

impl UrlQueue {
    pub fn push(&mut self, url: String) -> bool {
        if self.pending.len() >= 100 {
            return false;
        }
        let Some(id) = self.next_id.checked_add(1) else {
            return false;
        };
        self.next_id = id;
        self.routing = true;
        self.pending.push(PendingUrl { id, url });
        true
    }

    pub fn pending(&self) -> &[PendingUrl] {
        &self.pending
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn dismiss(&mut self, id: u64) {
        if self.pending.first().is_some_and(|item| item.id == id) {
            self.pending.remove(0);
        }
    }

    pub fn finish(&mut self) {
        if self.pending.is_empty() {
            self.routing = false;
        }
    }

    pub fn close_action(&self, presented: bool) -> CloseAction {
        match self.pending.first() {
            Some(item) => CloseAction::Dismiss(item.id),
            None if self.routing || presented => CloseAction::WaitForFrontend,
            None => CloseAction::CloseDashboard,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CloseAction, UrlQueue};

    #[test]
    fn duplicates_have_distinct_identities_and_stale_dismissal_is_idempotent() {
        let mut queue = UrlQueue::default();
        assert!(queue.push("https://example.com".into()));
        assert!(queue.push("https://example.com".into()));
        let first = queue.pending()[0].id;
        let second = queue.pending()[1].id;
        assert_ne!(first, second);
        queue.dismiss(first);
        queue.dismiss(first);
        assert_eq!(queue.pending().len(), 1);
        assert_eq!(queue.pending()[0].id, second);
        queue.dismiss(second);
        assert!(queue.is_empty());
        assert!(queue.push("https://example.com".into()));
        assert_ne!(queue.pending()[0].id, first);
        assert_ne!(queue.pending()[0].id, second);
    }

    #[test]
    fn only_the_displayed_head_can_be_consumed() {
        let mut queue = UrlQueue::default();
        queue.push("https://first.example".into());
        queue.push("https://second.example".into());
        queue.dismiss(queue.pending()[1].id);
        queue.dismiss(999);
        assert_eq!(queue.pending().len(), 2);
    }

    #[test]
    fn native_close_is_safe_during_startup_and_after_the_last_dismissal() {
        let mut queue = UrlQueue::default();
        assert_eq!(queue.close_action(false), CloseAction::CloseDashboard);
        queue.push("https://example.com".into());
        let id = queue.pending()[0].id;
        assert_eq!(queue.close_action(false), CloseAction::Dismiss(id));
        assert_eq!(queue.close_action(true), CloseAction::Dismiss(id));
        queue.dismiss(id);
        // Also protects a dismissal before present_browser_chooser's first frame.
        assert_eq!(queue.close_action(false), CloseAction::WaitForFrontend);
        assert_eq!(queue.close_action(true), CloseAction::WaitForFrontend);
        queue.finish();
        assert_eq!(queue.close_action(false), CloseAction::CloseDashboard);
        queue.push("https://next.example".into());
        assert_eq!(queue.close_action(true), CloseAction::Dismiss(id + 1));
        queue.finish();
        assert_eq!(queue.close_action(false), CloseAction::Dismiss(id + 1));
    }

    #[test]
    fn inbox_is_bounded_and_does_not_reuse_consumed_ids() {
        let mut queue = UrlQueue::default();
        for _ in 0..100 {
            assert!(queue.push("https://example.com".into()));
        }
        assert!(!queue.push("https://overflow.example".into()));
        queue.dismiss(queue.pending()[0].id);
        assert!(queue.push("https://next.example".into()));
        assert_eq!(queue.pending().last().unwrap().id, 101);
    }
}
