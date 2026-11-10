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
    #[cfg(any(target_os = "macos", windows, test))]
    next_id: u64,
    revision: u64,
}

impl UrlQueue {
    #[cfg(any(target_os = "macos", windows, test))]
    pub fn push(&mut self, url: String) -> bool {
        if self.pending.len() >= 100 {
            return false;
        }
        let Some(id) = self.next_id.checked_add(1) else {
            return false;
        };
        self.next_id = id;
        self.revision += 1;
        self.pending.push(PendingUrl { id, url });
        true
    }

    pub fn pending(&self) -> &[PendingUrl] {
        &self.pending
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn dismiss(&mut self, id: u64) {
        if self.pending.first().is_some_and(|item| item.id == id) {
            self.pending.remove(0);
            self.revision += 1;
        }
    }
}

/// One initial dashboard reveal, independent of the chooser queue lifetime.
#[derive(Default)]
#[cfg(any(target_os = "macos", windows, test))]
pub struct LaunchVisibility {
    pub page_loaded: bool,
    pub link_received: bool,
    decided: bool,
}

#[cfg(any(target_os = "macos", windows, test))]
impl LaunchVisibility {
    pub fn take_initial_reveal(&mut self, background: bool) -> bool {
        if self.decided || !self.page_loaded {
            return false;
        }
        self.decided = true;
        !background && !self.link_received
    }
}

#[cfg(test)]
mod tests {
    use super::{LaunchVisibility, UrlQueue};

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
    fn revisions_change_only_when_the_queue_changes() {
        let mut queue = UrlQueue::default();
        assert_eq!(queue.revision(), 0);
        queue.push("https://example.com".into());
        let id = queue.pending()[0].id;
        assert_eq!(queue.revision(), 1);
        queue.dismiss(id);
        queue.dismiss(id);
        assert_eq!(queue.revision(), 2);
    }

    #[test]
    fn launch_reveal_waits_for_page_load_and_remembers_consumed_launch_links() {
        let mut plain = LaunchVisibility::default();
        assert!(!plain.take_initial_reveal(false));
        plain.page_loaded = true;
        assert!(plain.take_initial_reveal(false));
        assert!(!plain.take_initial_reveal(false));
        for background in [false, true] {
            let mut link = LaunchVisibility {
                page_loaded: true,
                link_received: true,
                ..Default::default()
            };
            assert!(!link.take_initial_reveal(background));
        }
        let mut background = LaunchVisibility {
            page_loaded: true,
            ..Default::default()
        };
        assert!(!background.take_initial_reveal(true));
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
