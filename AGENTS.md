<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Chat history loads newest-first in pages and realtime/resync results are only merged by id, never replacing the list — loading oldest-first dropped recent messages once a room passed one page.
- "Delete for everyone" is a soft delete (`deleted_at` tombstone, content and media cleared server-side by `delete_room_message_for_everyone`) — a hard DELETE would never disappear on clients that missed the realtime event, since resyncs only merge by id. `merge` never lets a stale payload restore a deleted message.
