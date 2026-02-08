# Organization Routing Refactor Plan

## Overview

Refactor the home page routing structure so that organization selection is part of the URL route rather than component state. This will enable direct linking to the home page with a pre-selected organization.

## Current State

### Route: `/` (Home Page)

- **Component**: [`apps/frontend/app/page.tsx`](apps/frontend/app/page.tsx:1)
- **Behavior**:
  - Selected organization ID stored in local component state (`selectedOrgId`)
  - Displays organization list sidebar and workspace list
  - Cannot link directly to a specific organization
  - Currently redirects from `[orgId]/page.tsx` back to `/`

### Problems

1. Organization selection state is lost on page refresh or when sharing URLs
2. Cannot deep-link to a specific organization's workspace list
3. Inconsistent with existing routing patterns used elsewhere in the app

## Desired State

### Route: `/[orgId]` (using route group)

- **Behavior**:
  - Organization is passed as route parameter
  - Isolated layout (via route group) includes organization list sidebar
  - Page content displays workspace list for selected org
  - Direct linking supported (e.g., `/org-123` loads org-123's workspaces)
  - Does NOT affect child routes like `/[orgId]/workspace/*` or `/[orgId]/settings/*`

### Route: `/`

- **Behavior**:
  - Redirects to first available organization
  - Shows empty state if no organizations exist
  - Handles loading and error states

## Architecture Analysis

### Existing Patterns to Follow

The application already uses this pattern in several places:

1. **Organization Settings** ([`apps/frontend/app/[orgId]/settings/layout.tsx`](apps/frontend/app/[orgId]/settings/layout.tsx:1))
   - Layout includes [`Header`](apps/frontend/components/header.tsx:1) component
   - Fixed sidebar with [`OrgSettingsMenu`](apps/frontend/components/org-settings-menu.tsx:1)
   - Uses [`SidebarProvider`](apps/frontend/app/[orgId]/settings/layout.tsx:19)
   - Content area with proper margins and responsive layout

2. **Workspace Settings** ([`apps/frontend/app/[orgId]/workspace/[workspaceId]/settings/layout.tsx`](apps/frontend/app/[orgId]/workspace/[workspaceId]/settings/layout.tsx:1))
   - Similar pattern with fixed sidebar
   - Uses [`WorkspaceSettingsMenu`](apps/frontend/app/[orgId]/workspace/[workspaceId]/settings/layout.tsx:18)

3. **Workspace Layout** ([`apps/frontend/app/[orgId]/workspace/[workspaceId]/layout.tsx`](apps/frontend/app/[orgId]/workspace/[workspaceId]/layout.tsx:1))
   - Uses [`SidebarProvider`](apps/frontend/app/[orgId]/workspace/[workspaceId]/layout.tsx:50) with [`AppSidebar`](apps/frontend/app/[orgId]/workspace/[workspaceId]/layout.tsx:51)
   - Custom header with navigation controls

### Component Structure

```
Root Layout (app/layout.tsx)
└── AuthProvider
    └── ThemeProvider
        └── ClientProvider
            └── [Route-specific layouts]
```

## Implementation Plan

### 1. Create Organization List Sidebar Component

**File**: `apps/frontend/components/org-list-sidebar.tsx`

**Purpose**: Display list of organizations with selection state based on route parameter

**Features**:

- Fetch organizations using SWR
- Render organization list with [`SidebarMenu`](apps/frontend/components/org-settings-menu.tsx:9)
- Highlight active organization based on [`orgId`](apps/frontend/app/[orgId]/layout.tsx:3) route param
- Include "Add Organization" link at bottom
- Use [`usePathname()`](apps/frontend/components/org-settings-menu.tsx:13) for active state detection

**Similar to**: [`OrgSettingsMenu`](apps/frontend/components/org-settings-menu.tsx:1) pattern

### 2. Create Route Group Layout `[orgId]/(home)/layout.tsx`

**File**: `apps/frontend/app/[orgId]/(home)/layout.tsx` (NEW)

**Why Route Group?**
Route groups (using parentheses) allow us to create a layout that only applies to the org home page without affecting child routes like `/[orgId]/workspace/*` or `/[orgId]/settings/*`. The parentheses don't appear in the URL - `/[orgId]` still works as expected.

**Implementation**:

```tsx
import { Header } from "@/components/header";
import { HeaderHomeButton } from "@/components/header-home-button";
import { OrgListSidebar } from "@/components/org-list-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ProtectedRoute } from "@/components/protected-route";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <ProtectedRoute requireOrgAccess>
      <SidebarProvider>
        <div className="h-screen flex flex-col w-full overflow-hidden">
          <Header leftContent={<HeaderHomeButton />} />
          <div className="flex-1 flex flex-col items-center overflow-y-auto">
            <div className="flex flex-col md:flex-row w-full md:w-full lg:w-4/5 max-w-3xl py-8 px-4 md:px-0">
              {/* Fixed sidebar on desktop */}
              <div className="w-full md:w-64 md:fixed md:top-16 pt-3.5 mb-8 md:mb-0">
                <OrgListSidebar currentOrgId={orgId} />
              </div>
              {/* Content area with left margin to account for fixed sidebar */}
              <div className="flex-1 px-3 md:ml-64">{children}</div>
            </div>
            <div className="h-1 shrink-0" />
          </div>
        </div>
      </SidebarProvider>
    </ProtectedRoute>
  );
}
```

**Key Points**:

- Add [`SidebarProvider`](apps/frontend/app/[orgId]/settings/layout.tsx:19) wrapper
- Add [`Header`](apps/frontend/components/header.tsx:1) component
- Include new [`OrgListSidebar`](<apps/frontend/app/[orgId]/(home)/layout.tsx:1>) component
- Extract `orgId` from params and pass to sidebar
- Mirror layout structure from [`org settings layout`](apps/frontend/app/[orgId]/settings/layout.tsx:1)
- **Isolated to home page only** - won't affect `/[orgId]/workspace/*` or `/[orgId]/settings/*`

### 3. Move Page Content to `[orgId]/(home)/page.tsx`

**File**: `apps/frontend/app/[orgId]/(home)/page.tsx` (NEW)

**Purpose**: Display workspace list for the selected organization

**Implementation**:
Move workspace list content from current root [`page.tsx`](apps/frontend/app/page.tsx:1) (lines 184-240) to this new route group page

```tsx
"use client";

import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Settings, FolderClosed } from "lucide-react";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { Workspace, Organization } from "@platypus/schemas";

export default function OrgPage({ params }: { params: { orgId: string } }) {
  const backendUrl = useBackendUrl();

  // Fetch organization details
  const { data: orgData } = useSWR<Organization>(
    backendUrl ? joinUrl(backendUrl, `/organizations/${params.orgId}`) : null,
    fetcher,
  );

  // Fetch workspaces for this org
  const { data: workspacesData, isLoading: isWorkspacesLoading } = useSWR<{
    results: Workspace[];
  }>(
    backendUrl
      ? joinUrl(backendUrl, `/organizations/${params.orgId}/workspaces`)
      : null,
    fetcher,
  );

  const workspaces = workspacesData?.results || [];

  return (
    <div className="space-y-6">
      {workspaces.length > 0 ? (
        <div className="space-y-4">
          <WorkspaceList orgId={params.orgId} />
          <div className="flex items-center gap-2">
            <Button asChild>
              <Link href={`/${params.orgId}/create`}>
                <Plus className="size-4" /> Add workspace
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/${params.orgId}/settings`}>
                <Settings className="size-4" /> Organization Settings
              </Link>
            </Button>
          </div>
        </div>
      ) : !isWorkspacesLoading ? (
        <Empty className="border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderClosed />
            </EmptyMedia>
            <EmptyTitle>No workspaces found</EmptyTitle>
            <EmptyDescription>
              Create your first workspace in this organization to start building
              agents.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex items-center gap-2">
              <Button asChild className="flex-1">
                <Link href={`/${params.orgId}/create`}>
                  <Plus className="h-4 w-4" /> Create Workspace
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/${params.orgId}/settings`}>
                  <Settings className="size-4" /> Organization Settings
                </Link>
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      ) : null}
    </div>
  );
}
```

**Key Changes**:

- Remove redirect
- Move workspace list rendering from root page
- Use `params.orgId` from route instead of state
- Simplified - no longer needs to manage org selection state
- Layout (sidebar, header) is now handled by parent layout

### 4. Update Root Page `/`

**File**: [`apps/frontend/app/page.tsx`](apps/frontend/app/page.tsx:1)

**New Implementation**:

```tsx
"use client";

import type { Organization } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { AlertCircle, Building, Plus } from "lucide-react";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "./client-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ProtectedRoute } from "@/components/protected-route";
import { Header } from "@/components/header";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useAuth } from "@/components/auth-provider";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const { user, isAuthLoading: isAuthLoadingUser } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const { data, error, isLoading } = useSWR<{ results: Organization[] }>(
    backendUrl && user ? joinUrl(backendUrl, "/organizations") : null,
    fetcher,
  );

  const organizations = data?.results || [];

  // Redirect to first organization if available
  useEffect(() => {
    if (organizations.length > 0) {
      router.replace(`/${organizations[0].id}`);
    }
  }, [organizations, router]);

  if (!backendUrl) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Configuration Error</AlertTitle>
          <AlertDescription>
            The <code>BACKEND_URL</code> environment variable is not set.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isAuthLoadingUser || (user && isLoading)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load organizations</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Only show empty state if no organizations
  if (organizations.length === 0) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen flex flex-col">
          <Header />
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <Empty className="border-none">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Building />
                </EmptyMedia>
                <EmptyTitle>No organizations found</EmptyTitle>
                <EmptyDescription>
                  Get started by creating your first organization to manage your
                  workspaces and agents.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild className="w-full">
                  <Link href="/create">
                    <Plus className="h-4 w-4" /> Create Organization
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  // Show loading while redirecting
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
    </div>
  );
}
```

**Key Changes**:

- Remove organization sidebar and workspace list rendering
- Add redirect to first organization when organizations exist
- Keep empty state for when user has no organizations
- Keep loading and error states
- Much simpler component - only handles initial routing decision

### 5. Check for Navigation Link Updates

**Files to Review**:

- Any components linking to root `/` that should link to specific org
- Verify all org-based navigation still works

**Expected Impact**: Minimal, as most navigation already uses `/${orgId}` format

### 6. Edge Cases & Error Handling

#### No Organizations

- **Current**: Shows empty state at `/`
- **New**: Same behavior at `/`, attempts to access `/[orgId]` return 404

#### Invalid orgId

- **Handled by**: Existing [`ProtectedRoute`](apps/frontend/components/protected-route.tsx:1) with `requireOrgAccess`
- Shows 404 if orgId doesn't exist or user lacks access

#### Loading States

- **Root page**: Shows spinner while checking for orgs, then redirects
- **Org page**: Layout loads first, sidebar shows loading state while fetching orgs
- **Workspace list**: Shows loading state while fetching workspaces

#### Direct Links

- **`/[orgId]`**: Works immediately, shows selected org's workspaces
- **`/`**: Redirects to first org (consistent behavior)

## File Changes Summary

### New Files

- [`apps/frontend/components/org-list-sidebar.tsx`](apps/frontend/components/org-list-sidebar.tsx:1) - Organization list sidebar component

### Modified Files

- [`apps/frontend/app/page.tsx`](apps/frontend/app/page.tsx:1) - Simplified to redirect or show empty state
- [`apps/frontend/app/[orgId]/layout.tsx`](apps/frontend/app/[orgId]/layout.tsx:1) - Add sidebar and header structure
- [`apps/frontend/app/[orgId]/page.tsx`](apps/frontend/app/[orgId]/page.tsx:1) - Display workspace list (moved from root)

### Navigation Impact

- Links to `/` in workspace breadcrumbs should work (redirects to first org)
- Links to `/${orgId}` now work as expected
- Direct deep links to specific orgs now possible

## Testing Checklist

- [ ] Navigate to `/` redirects to first organization
- [ ] Navigate to `/[orgId]` shows correct org's workspaces
- [ ] Sidebar highlights active organization correctly
- [ ] Clicking different org in sidebar navigates to that org's page
- [ ] "Add Organization" link works from sidebar
- [ ] "Add workspace" button works
- [ ] "Organization Settings" button works
- [ ] Empty states display correctly (no orgs, no workspaces)
- [ ] Loading states work properly
- [ ] Direct links to specific orgs work
- [ ] Browser back/forward navigation works
- [ ] Refresh page maintains selected org
- [ ] Protected route authorization works

## Benefits

1. **Direct Linking**: Share URLs with specific organization pre-selected
2. **State Persistence**: Organization selection survives page refresh
3. **Consistency**: Matches existing routing patterns in the app
4. **Better UX**: Browser history tracks org navigation
5. **SEO**: Server can render correct org content (future optimization)

## Migration Notes

- **Breaking Changes**: None for users (root page redirects gracefully)
- **Backward Compatibility**: Old `/` links still work via redirect
- **Data**: No database changes required
- **APIs**: No backend changes required
