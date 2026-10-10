# ShiftBridge — Chat-first frontend

A responsive, accessible-first frontend concept for ShiftBridge, a small-business team messenger with operational task management. The **single group chat** is the home screen for employees and administrators. On mobile a large raised **Chat** button sits between smaller **Tasks** and **Shift** buttons; administrators also have a separate **Manage** area.

## Run it

No installation or external API keys needed; Node 18+ is sufficient.

```bash
npm run dev
```

Open http://localhost:3000. The frontend can also be hosted as a static site (GitHub Pages, Netlify, or Vercel) because it uses hash routes and no server-side rendering. `npm run check` syntax-checks every JavaScript file.

## Screens and URLs

- `#/chat` — one shared group conversation, workspace switcher, message composer
- `#/tasks` and `#/task/t1` — My Tasks, task detail, manual status changes and evidence
- `#/shift`, `#/handover` — attendance controls and five-question handover
- `#/profile` — demo role switch, profile and workspace switcher
- `#/manage` — admin business overview and management shortcuts
- `#/manage/attention` — unresolved issues and requests requiring review
- `#/manage/all-work` — all workspace tasks and issues
- `#/manage/team` — members and shift overview
- `#/manage/invites` — sample invite code and instructions
- `#/manage/rules` — editable safe-category auto-assignment policy mockup
- `#/manage/settings` — workspace details
- `#/manage/issue/i1` — evidence, inspection approval and verified resolution form
- `#/workspace/create`, `#/workspace/invite`, `#/workspace/rules` — new-business onboarding screens

The same screen components adapt to mobile and desktop. Employee mode removes Manage navigation. In the Profile screen you can switch between administrator/employee **for preview purposes only**.

## Features you can interact with

- Send text messages in the workspace's **single chat**.
- Switch between two fictional workspaces; their messages, tasks and issues remain separated within the browser demo state.
- Filter personal tasks, start a task, report completion or a blocker. Admin can verify submitted completion and review issue records.
- Create manual tasks as an administrator.
- Clock in/out, submit handover and edit business setup information.
- Configure a *visual* set of AI permissions. Protected repair, spending and safety permissions are locked off.
- Create another demo workspace and copy a demonstrative invitation code.
- Demo changes persist in `localStorage`; use Profile → Reset demo data to start again.

## IMPORTANT: What this is and is not

This repository currently contains **frontend-only prototype functionality** built with standard HTML/CSS/JavaScript. The task records and messages are sample/local data. **There is no real authentication, invitation validation, database, live multi-user chat, WorkBuddy agent, or automatic assignment.** No UI role toggle is production authorization. Generated invite codes do not grant access and are not secure invitations. The application never contacts a server to verify attendance or resolve equipment safety. These limitations are surfaced in relevant screens.

Before using this with real employees, implement and test:

1. Supabase Auth, secure roles and **workspace-scoped RLS on all data**;
2. Real message persistence and synchronization, with **one chat per workspace**;
3. A permitted WorkBuddy tool/agent workflow that analyzes shared work messages and creates authorized tasks, with audited evidence and safeguards;
4. Deterministic eligibility, on-duty filtering, workload-aware assignment and review/approval policies;
5. Completion verification and issue resolution as independent records;
6. Revocable, expiring, server-validated invitations and actual attendance records.

Do not treat any seeded AI activity, attendance or notifications in this frontend as a live system result.

## Structure

- `index.html` — app mount, metadata
- `styles.css` — mobile-first visual design and responsive desktop chat
- `src/data.js` — sample workspace data, helpers and escaping
- `src/icons.js` — inline SVG icons (no external CDN)
- `src/app.js` — hash router, screen rendering and local demo interactions
- `scripts/serve.mjs` — minimal static file server
- `assets/mark.svg` — ShiftBridge mark

The package has **no npm dependencies** so it can be previewed immediately while the backend architecture is developed separately.