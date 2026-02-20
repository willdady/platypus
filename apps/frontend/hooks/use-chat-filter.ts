"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";

export const useChatFilter = () => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const selectedTags =
    searchParams.get("tags")?.split(",").filter(Boolean) ?? [];

  const toggleFilterTag = (tag: string) => {
    const newTags = selectedTags.includes(tag)
      ? selectedTags.filter((t) => t !== tag)
      : [...selectedTags, tag];
    updateUrl(newTags);
  };

  const updateUrl = (tags: string[]) => {
    const params = new URLSearchParams(searchParams);
    if (tags.length > 0) {
      params.set("tags", tags.join(","));
    } else {
      params.delete("tags");
    }
    router.replace(`${pathname}?${params.toString()}`);
  };

  const clearFilters = () => {
    updateUrl([]);
  };

  return { selectedTags, toggleFilterTag, clearFilters };
};
