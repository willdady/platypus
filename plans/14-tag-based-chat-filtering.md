# Implementation Plan: Tag-Based Chat Filtering

## Context

Currently, the workspace home screen displays a tag cloud showing all tags used across chats, but these tags are purely informational with no interaction. Users cannot filter chats by tags, making it difficult to find related conversations. This implementation adds clickable tag filtering to help users quickly locate chats with specific tags.

**Current State:**
- TagCloud component displays tags with counts (not clickable)
- AppSidebar shows chats grouped by "Pinned", "Last 7 days", "Other"
- Chats fetched via SWR from `/organizations/${orgId}/workspaces/${workspaceId}/chat`
- Backend supports tag filtering via `?tags=` query parameter ✅
- GIN index on `chat.tags` for performance ✅

**Desired State:**
- Clicking a tag in TagCloud toggles the tag filter (adds if not selected, removes if selected)
- Selected tags are visually highlighted in the TagCloud
- URL-based filter state for shareable links

## Approach

**Server-side filtering with URL state management**

### Why server-side?
- Better scalability with large chat datasets
- Consistent with existing pagination pattern
- GIN index on tags for fast lookups ✅
- Reduces client memory footprint

### Why URL parameters?
- Shareable filter URLs (e.g., `?tags=project-alpha,urgent`)
- Browser history support (back button works)
- Persists across page refreshes
- Already used in codebase (see `apps/frontend/app/[orgId]/workspace/[workspaceId]/chat/page.tsx`)

### Tag selection model
Multiple tags with OR logic (union) - shows chats containing ANY of the selected tags. Clicking a tag toggles its selection (adds if not selected, removes if already selected). Selected tags are visually highlighted in the TagCloud.

## Implementation

### 1. Backend Changes ✅ COMPLETE

- Added `tags` query parameter to GET `/` endpoint in `apps/backend/src/routes/chat.ts`
- Added GIN index `idx_chat_tags` on `chat.tags` in `apps/backend/src/db/schema.ts`
- Uses PostgreSQL `?|` operator to check if JSONB array contains any of the provided values

### 2. Frontend State Management

**File: `apps/frontend/hooks/use-chat-filter.ts` (NEW)**

Create custom hook to manage filter state:

```typescript
export const useChatFilter = () => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const selectedTags = searchParams.get('tags')?.split(',').filter(Boolean) ?? [];

  const toggleFilterTag = (tag: string) => {
    const newTags = selectedTags.includes(tag)
      ? selectedTags.filter(t => t !== tag)
      : [...selectedTags, tag];
    updateUrl(newTags);
  };

  const updateUrl = (tags: string[]) => {
    const params = new URLSearchParams(searchParams);
    if (tags.length > 0) {
      params.set('tags', tags.join(','));
    } else {
      params.delete('tags');
    }
    router.replace(`${pathname}?${params.toString()}`);
  };

  return { selectedTags, toggleFilterTag };
};
```

### 3. UI Components

**File: `apps/frontend/components/tag-cloud.tsx`**

Make tags clickable with toggle behavior and visual feedback:

- Add props: `onTagToggle?: (tag: string) => void` and `selectedTags?: string[]`
- Change cursor from `cursor-default` to `cursor-pointer`
- Add `variant={selectedTags?.includes(tagData.tag) ? "default" : "secondary"}` to highlight selected tags
- Add `onClick={() => onTagToggle?.(tagData.tag)}` to Badge

**File: `apps/frontend/components/app-sidebar.tsx`**

Integrate filtering:

1. Import and use `useChatFilter` hook
2. Update SWR fetch to include tags parameter:

```typescript
const tagsParam = selectedTags.length > 0 ? `&tags=${selectedTags.join(',')}` : '';
const { data: chatData } = useSWR<{ results: ChatListItem[] }>(
  backendUrl && user
    ? joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/chat?limit=100${tagsParam}`,
      )
    : null,
  fetcher,
);
```

**File: `apps/frontend/app/[orgId]/workspace/[workspaceId]/page.tsx`**

Pass filter callbacks to TagCloud:

```typescript
const { selectedTags, toggleFilterTag } = useChatFilter();

<TagCloud
  orgId={orgId}
  workspaceId={workspaceId}
  selectedTags={selectedTags}
  onTagToggle={toggleFilterTag}
/>
```

## Verification

### Manual Testing

1. **Setup**: Start app with `pnpm dev`, ensure you have chats with various tags
2. **Toggle Tag On**: Click a tag in the TagCloud on workspace home
3. **Expected**: URL updates with `?tags=selected-tag`, sidebar shows only chats with that tag, tag is visually highlighted
4. **Toggle Tag Off**: Click the same tag again
5. **Expected**: Tag is removed from URL, all chats shown, tag no longer highlighted
6. **Multiple Tags**: Click two different tags
7. **Expected**: URL has both tags (`?tags=tag1,tag2`), sidebar shows chats with either tag, both tags highlighted
8. **Toggle Off One**: Click one of the selected tags
9. **Expected**: That tag removed from URL and filter, other tag remains selected
10. **Share URL**: Copy URL with tags and open in new tab
11. **Expected**: Filters persist, same filtered view shown, correct tags highlighted

### Backend Testing ✅ COMPLETE

Backend tag filtering has been implemented and tested via Bruno API client.

### Edge Cases

- Empty tags param: `?tags=` should behave like no filter
- Non-existent tag: Returns empty result
- Special characters: Tags are kebab-case validated, so no special handling needed
- Large tag count: Test with 5+ tags selected (max per chat is 5)

## Files Modified

### Backend ✅ COMPLETE
- `apps/backend/src/routes/chat.ts` - Add tag filtering to GET endpoint
- `apps/backend/src/db/schema.ts` - Add GIN index for performance
- `apps/backend/drizzle/0012_icy_xavin.sql` - Migration for GIN index

### Frontend (TODO)
- `apps/frontend/hooks/use-chat-filter.ts` (NEW) - Filter state management with toggle
- `apps/frontend/components/tag-cloud.tsx` - Make tags clickable with toggle and visual highlight
- `apps/frontend/components/app-sidebar.tsx` - Update chat fetching to include tags parameter
- `apps/frontend/app/[orgId]/workspace/[workspaceId]/page.tsx` - Pass filter callbacks to TagCloud

## Tests (TODO)

### Backend Tests
- `apps/backend/src/routes/chat.test.ts` - Add tests for tag filtering:
  - GET with single tag returns chats containing that tag
  - GET with multiple tags returns chats containing any of the tags (OR logic)
  - GET with non-existent tag returns empty array
  - GET without tags param returns all chats (backward compatible)

### Frontend Tests
- `apps/frontend/hooks/use-chat-filter.test.ts` - Test the hook:
  - `selectedTags` extracts tags from URL correctly
  - `toggleFilterTag` adds tag when not present
  - `toggleFilterTag` removes tag when present
  - URL updates correctly with multiple tags
  - URL param removed when all tags toggled off

- `apps/frontend/components/tag-cloud.test.tsx` - Test the component:
  - Clicking a tag calls `onTagToggle` with correct tag
  - Selected tags have different visual styling
  - Cursor changes to pointer on hover
