// Stands in for "next/cache" when the MCP server is compiled for the release
// app. There is no page to revalidate outside Next; the app's pages read the
// database on every request, so they show MCP edits on their next load anyway.
export function revalidatePath(): void {}
