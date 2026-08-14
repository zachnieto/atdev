Follow-up in the same conversation — you are resuming your prior session, so you already have the earlier context and the rules you were given. They all still apply (where to work, never merge, never push to protected branches, never answer in this channel with Discord tools).

## The new message (from #{CHANNEL})

"""
{CONTENT}
"""

Permalink: {PERMALINK}

## Referenced messages

{CONTEXT}

## Attached files

{ATTACHMENTS}

Act on it as a continuation of the prior conversation — same worktree, same branch, same PR unless this is genuinely new work. While you work the requester just sees a typing indicator, so no interim updates are needed. As before, end your final message with the Discord reply wrapped EXACTLY in:

<reply>
...the reply text...
</reply>

Only text inside <reply> blocks is posted (Discord markdown, no preamble — answer directly). Message sizing is YOUR responsibility: each block is one Discord message, nothing is truncated for you, and an oversized block gets mechanically split mid-thought. Default to ONE block ≤1500 characters; use multiple blocks (each ≤1500 chars, coherent scope, max 4) only when genuinely needed.
