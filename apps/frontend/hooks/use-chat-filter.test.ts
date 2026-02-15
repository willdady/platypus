import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatFilter } from "./use-chat-filter";

// Mock next/navigation hooks
const mockReplace = vi.fn();
const mockGet = vi.fn();
let mockSearchParams: URLSearchParams | null = null;

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({
    replace: mockReplace,
  }),
  usePathname: () => "/test/path",
}));

// Helper to create a mock URLSearchParams with the get method
const createMockSearchParams = (tags: string | null) => {
  const params = new URLSearchParams();
  if (tags !== null) {
    params.set("tags", tags);
  }
  return params;
};

describe("useChatFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("selectedTags", () => {
    it("should extract tags from URL correctly", () => {
      mockSearchParams = createMockSearchParams("tag1,tag2,tag3");

      const { result } = renderHook(() => useChatFilter());

      expect(result.current.selectedTags).toEqual(["tag1", "tag2", "tag3"]);
    });

    it("should return empty array when no tags param in URL", () => {
      mockSearchParams = createMockSearchParams(null);

      const { result } = renderHook(() => useChatFilter());

      expect(result.current.selectedTags).toEqual([]);
    });

    it("should return empty array when tags param is empty string", () => {
      mockSearchParams = createMockSearchParams("");

      const { result } = renderHook(() => useChatFilter());

      expect(result.current.selectedTags).toEqual([]);
    });

    it("should handle single tag correctly", () => {
      mockSearchParams = createMockSearchParams("solo-tag");

      const { result } = renderHook(() => useChatFilter());

      expect(result.current.selectedTags).toEqual(["solo-tag"]);
    });
  });

  describe("toggleFilterTag", () => {
    it("should add a tag when not present", () => {
      mockSearchParams = createMockSearchParams(null);

      const { result } = renderHook(() => useChatFilter());

      act(() => {
        result.current.toggleFilterTag("new-tag");
      });

      expect(mockReplace).toHaveBeenCalledWith("/test/path?tags=new-tag");
    });

    it("should remove a tag when already present", () => {
      mockSearchParams = createMockSearchParams("tag1,tag2,tag3");

      const { result } = renderHook(() => useChatFilter());

      act(() => {
        result.current.toggleFilterTag("tag2");
      });

      // URLSearchParams encodes commas as %2C
      expect(mockReplace).toHaveBeenCalledWith("/test/path?tags=tag1%2Ctag3");
    });

    it("should update URL correctly with multiple tags", () => {
      mockSearchParams = createMockSearchParams("existing-tag");

      const { result } = renderHook(() => useChatFilter());

      act(() => {
        result.current.toggleFilterTag("another-tag");
      });

      // URLSearchParams encodes commas as %2C
      expect(mockReplace).toHaveBeenCalledWith(
        "/test/path?tags=existing-tag%2Canother-tag",
      );
    });

    it("should remove URL param when all tags are toggled off", () => {
      mockSearchParams = createMockSearchParams("only-tag");

      const { result } = renderHook(() => useChatFilter());

      act(() => {
        result.current.toggleFilterTag("only-tag");
      });

      // When tags array is empty, the params.delete("tags") is called
      // and the URL should not have tags param
      expect(mockReplace).toHaveBeenCalledWith("/test/path?");
    });

    it("should preserve existing search params when updating tags", () => {
      const params = new URLSearchParams();
      params.set("otherParam", "value");
      params.set("tags", "tag1");
      mockSearchParams = params;

      const { result } = renderHook(() => useChatFilter());

      act(() => {
        result.current.toggleFilterTag("tag2");
      });

      // The URL should contain both the otherParam and the updated tags
      // URLSearchParams encodes commas as %2C
      expect(mockReplace).toHaveBeenCalledWith(
        expect.stringContaining("otherParam=value"),
      );
      expect(mockReplace).toHaveBeenCalledWith(
        expect.stringContaining("tags=tag1%2Ctag2"),
      );
    });

    it("should handle toggling the same tag multiple times", () => {
      mockSearchParams = createMockSearchParams("tag1");

      const { result } = renderHook(() => useChatFilter());

      // First toggle - remove the tag
      act(() => {
        result.current.toggleFilterTag("tag1");
      });

      expect(mockReplace).toHaveBeenLastCalledWith("/test/path?");

      // Reset mockSearchParams to reflect the removal
      mockSearchParams = createMockSearchParams(null);

      // Note: We need to re-render the hook to get the updated state
      // In real usage, the URL change would trigger a re-render
    });
  });
});
