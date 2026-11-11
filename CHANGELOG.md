# Changelog

## [Unreleased]

## [4.17.2.2] - 2026-11-11

### Fixed

- Batch repeated post scans and skip writes when an existing media ID is correct.
- Copy and retain video playback buffers only on story routes.
- Limit exposed extension assets to Instagram pages.

## [4.17.1.1] - 2026-11-05

### Fixed

- Stop registering a browser-wide filename listener when the addon starts or sits idle.
  This conflicted with RegExp Organizer routing on unrelated sites in the user's browser.
- Register filename handling only for an owned file's handoff, then remove it immediately after
  supplying that filename, including error/cancel cleanup. The listener does not remain active
  during the rest of the file transfer or between batch items.

Other extensions' rules and settings are unchanged.

## [4.17.0.2] - 2026-11-04

### Added

- Recover a current video's already-loaded MP4 bytes when its blob source has no poster or
  accessible metadata. Capture is tied to the exact MediaSource; separate clear audio/video
  buffers are joined into one MP4 with no re-encoding or metadata API request.
- Stable content-based fallback filenames and chunked delivery into the normal cache/download
  handler. Single stories continue to use the date folder without a profile subfolder.

### Fixed

- Route legacy individual-post, carousel and avatar buttons through the managed date-folder
  handler. Their old native-anchor path bypassed automatic routing and could save in Downloads.
- Preserve the selected video during recovery, then restore playback. Incomplete, unsupported,
  encrypted or over-limit captures are refused instead of saving a broken or silent substitute.

## [4.16.3.2] - 2026-11-04

### Fixed

- Create the Instagram-handle subfolder only for a profile's Download All. Individual media and
  stories save directly in the date folder, with separate saved-file tracking per destination.
- Match the clicked video element before inspecting its player data; a same-sized poster image
  no longer takes precedence. Empty legacy source lists no longer hide populated video resources.
- Read ID/poster-matched progressive player sources without substituting unrelated preloaded media.

### Added

- Safe story-failure details in Options: source type, candidate counts and response status/type.
  No account names, media IDs, URLs, cookies or tokens are recorded.

## [4.16.2.1] - 2026-11-04

### Fixed

- Save a visible highlight photo using its detected profile owner even when React media metadata
  is unavailable. Recognize absolute and story-profile header links.
- Add an alternate highlight query when the REST reel endpoint returns 404 or a server error.
  Match the requested highlight and exact current asset; do not retry account restrictions.
- Support GraphQL image and video resource lists without saving video posters as videos.

### Added

- Verified Prod update helper that builds, tests, preserves private folder configuration and
  backs up the previous private copy. Source remains sanitized.

## [4.16.1.1] - 2026-11-04

### Changed

- Use a generic Instagram download root and synthetic media examples throughout source and tests.
- Accept upstream build/test locations through LWL_UPSTREAM_DIR and LWL_ORGANIZER_DIR instead
  of depending on a particular browser profile or local installation path.
- Rebuild from an explicit package asset list and remove unused analytics endpoint configuration.

### Added

- A privacy audit in the build that rejects personal home paths, credential-like strings,
  unreviewed email contacts, and tracked private Prod/local-input files. Required third-party
  copyright notices remain intact.

The separately loaded private Prod copy is unchanged. Redistribution rights for inherited
third-party code remain unresolved; this privacy cleanup is not publication clearance.

## [4.16.0.2] - 2026-11-04

### Fixed

- Explicitly supply the full date/profile filename during browser filename determination.
  The previous build's requested path was lost and its first file saved as a UUID in Downloads.
- Report destination mismatches without assuming another extension caused them.
- Keep loose media files in the profile folder, with no ZIP or rule-copying step.

### Added

- Persistent media cache enabled by default, bounded to 512 MB and seven days. Retries reuse
  fetched media, and files the browser confirms are already saved today are skipped.
- Two concurrent transfers after verifying the first new save, instead of a single-file queue
  with a one-second polling delay for every file.
- Quiet browser download UI during batches by default, restored on completion, Stop or tab close.
  Files retain individual download-history entries. Quiet mode can be disabled in Options.
- Cache clearing in Options, which preserves downloaded photos and videos.

## [4.15.0.2] - 2026-11-04

### Changed

- Automatic date and Instagram-handle folders are enabled by default. No Organizer rule needs
  to be copied or enabled. The layout follows your existing Instagram date folders.
- Keep custom RegExp Organizer routing as an optional mode in Options.
- Apply dark LWL styling to the remaining original addon notifications and close controls.

### Fixed

- Create automatic downloads in the addon's own context so a generic Instagram URL rule cannot
  replace their descriptive filenames or remove the profile subfolder.
- Stop cancels both media fetching and active automatic downloads. Completed files stay on disk.

## [4.14.0.2] - 2026-11-04

### Fixed

- Hand filenames to the browser the same way as single-post downloads, preserving the owner,
  timestamp and media ID instead of accepting a blob UUID.
- Show post/file counts while scanning and completed-file percentages only while saving.
- Check the actual saved filename and profile subfolder before continuing the queue. Missing
  or overridden Organizer routing stops after the first mismatched file.

### Added

- A Stop button that aborts scanning, media fetching and the current browser download.
  Completed files stay on disk.
- Options guidance for enabling the handle-folder rule above the original generic rule.

## [4.13.5.1] - 2026-11-04

### Fixed

- Validate the actual downloadable posts before rejecting a timeline accompanied by query errors.
  Error severity or unfamiliar optional-field paths alone no longer discard otherwise usable media.
- Check every post, carousel slide and video source; incomplete media still stops the scan.
- Normalize owner fields, inherited carousel timestamps and empty video arrays for photo downloads.
- Always stop recognized account restrictions, even if the response also contains post data.

## [4.13.4.1] - 2026-11-04

### Fixed

- Preserve new boolean/numeric/null query parameters and the page's original counts instead of
  combining its newer query document with an older parameter allowlist.
- Accept timeline nodes/items layouts with explicit pagination and warning-only responses.

### Added

- One reference-query fallback for an incompatible, error-free observed first-page response.
  Pagination stays with the selected query; account restrictions are not retried.
- Last batch failure details in Options, with copyable query/schema types and safe codes.
  Account names, media URLs, cookies, tokens and raw server bodies are excluded.

## [4.13.3.1] - 2026-11-04

### Fixed

- Accept complete profile post data when only optional comment or caption fields report errors.
- Recognize wrapped profile media nodes and stop on incomplete downloadable media.
- Distinguish query restrictions, login/account checks, access denial and query execution errors.

### Changed

- Use the profile-query identifier and boolean feature flags observed from Instagram's own page
  when available, with the existing reference query as fallback. Authentication fields and old
  pagination cursors are never retained by this observer.
- Unknown query failures show only safe error codes, query ID and top-level schema field names.

## [4.13.2.2] - 2026-11-04

### Fixed

- Keep a known video's source when Instagram later supplies thumbnail-only data for it.

## [4.13.2.1] - 2026-11-04

### Fixed

- Read story and highlight media already loaded in the viewer before making metadata API requests.
- Read the currently displayed highlight item without requiring a story ID in its URL.
- Use directly displayed image/video URLs for ordinary stories when available.
- Try exact-ID reel lookup after a metadata server error, and identify the failed request in errors.

### Changed

- Keep a bounded in-memory cache of story media from Instagram's own responses. Raw responses,
  session tokens and cookies are never included in messages or saved by this reader.

## [4.13.1.2] - 2026-11-04

### Fixed

- Clear the previous story's status when switching stories.

### Added

- Settings help for the story download buttons and Ctrl+Shift+D shortcut.

## [4.13.1.1] - 2026-11-04

### Fixed

- Download the current story without requiring its owner to appear in Instagram's home-story tray.
- Match numeric and string story IDs consistently and capture the selected ID before fetching.
- Keep story buttons available when the viewer loads late, changes layout, or replaces its controls.
- Save a video story as video rather than its poster image.

### Changed

- Current-story and all-story downloads use the existing RegExp Organizer-compatible browser downloads.
- Story controls sit below the visible story's top-right corner and stop clicks from advancing playback.

## [4.13.0.1] - 2026-11-01

### Added

- LWL Instagram Downloader name, icon, settings, About information and original-author credit.
- Copyable RegExp Download Organizer rule for date folders with a profile-name subfolder.

### Changed

- Download All uses browser downloads so RegExp Organizer can organize each file.
- The old remembered batch folder no longer controls profile downloads.
- Wait for each browser download to finish and stop if it fails or is cancelled.
- Name conflicts follow the organizer rule, including its Uniquify setting.

## [4.12.16.2] - 2026-11-01

### Fixed

- Resolve numeric profile IDs and use a numeric feed URL, with a current web-query fallback.
- Report unavailable request URLs without incorrectly treating them as sign-in failures.

## [4.12.16.1] - 2026-11-01

### Fixed

- Handle a missing Instagram session claim without crashing.
- Remove the batch scan's separate dependency on profile-info lookup.

### Changed

- Disable upstream analytics in the private local repair.
