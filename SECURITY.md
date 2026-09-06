# Security and privacy

## Supported releases

Security fixes are applied to the latest release of each Skill listed in
`catalog.json`. Older release assets remain immutable and may be superseded.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not put
credentials, cookies, private profile data, unpublished task output, or live
account details in a public issue.

## Release boundary

This repository publishes technical frameworks and executors. A release must
not contain:

- cookies, tokens, passwords, authorization headers, or browser profile data;
- a real task's target URL, account list, date range, page or item target,
  checkpoint, output, screenshot, log, or review decision;
- machine-specific home directories, drive paths, temporary directories, or
  private network locations;
- symlinks, path traversal members, undeclared archive files, or generated
  caches.

Public CI uses synthetic fixtures and offline harnesses. It does not sign in to
social platforms. A local live test must use an authorized account and the
user-selected Chrome Profile. Verification, rate limiting, and access denial
must pause the task; the project does not provide challenge bypasses.

## External effects

The initial Skills are read-only. Following, liking, saving, commenting,
messaging, inviting, publishing, buying, or changing an account requires a
separate explicit capability and user authorization. Task Master manages the
browser and task lifecycle; a Skill does not create a second browser
controller.
