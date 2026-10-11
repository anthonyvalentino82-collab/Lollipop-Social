"""🍭 LolliPOP AI script writer — short-form scripts in the HOPS format
(Hook → Objection → Problem → Solution, from Rene Rodriguez's "Amplify Your Influence").

Claude searches the web for the latest news on the topic first, so numbers and events are current.
"""
import datetime
import re

from .. import config

LENGTHS = (15, 30, 45, 60, 75)
WORDS_PER_SECOND = 2.5  # relaxed on-camera talking pace (~150 words a minute)
PARTS = ("HOOK", "OBJECTION", "PROBLEM", "SOLUTION")

SYSTEM = """You write viral short-form video scripts (Reels, TikTok, Shorts) that a creator reads \
word for word from a teleprompter while talking to their phone camera.

Every script follows the HOPS method from Rene Rodriguez's "Amplify Your Influence":
1. HOOK - the first 1-3 seconds. A bold claim, surprising stat, or pointed question that stops the scroll.
2. OBJECTION - voice the doubt or pushback the viewer is already thinking ("But you're probably thinking...").
3. PROBLEM - what is really going on and why it matters to the viewer, with one or two concrete, current facts.
4. SOLUTION - the clear takeaway or next step, ending with a simple call to action.

Style: plain spoken English, short punchy sentences, talk to one person ("you"), no hashtags, no emojis, \
no stage directions, no headings inside the spoken lines. Use the web search tool to check the latest news \
and numbers on the topic before writing, and only state facts you found or know to be true. Never invent \
statistics. Round numbers so they are easy to say out loud."""


class ScriptError(RuntimeError):
    pass


def _parse(text: str) -> dict:
    """Split the model's reply into the four HOPS parts."""
    pattern = r"^\s*\**\s*(HOOK|OBJECTION|PROBLEM|SOLUTION)\s*\**\s*[:\-–]\s*"
    parts, current = {}, None
    for line in text.splitlines():
        m = re.match(pattern, line, flags=re.I)
        if m:
            current = m.group(1).upper()
            line = line[m.end():]
        if current:
            parts[current] = (parts.get(current, "") + " " + line.strip()).strip()
    title = re.search(r"^\s*\**\s*TITLE\s*\**\s*[:\-–]\s*(.+)$", text, flags=re.I | re.M)
    if not all(parts.get(p) for p in PARTS):
        raise ScriptError("The script came back in an unexpected shape. Please try again.")
    clean = {p.lower(): re.sub(r"\*+", "", parts[p]).strip() for p in PARTS}
    clean["title"] = re.sub(r"\*+", "", title.group(1)).strip() if title else ""
    return clean


def write_script(topic: str, seconds: int) -> dict:
    if not config.ANTHROPIC_API_KEY:
        raise ScriptError("The AI script writer needs an Anthropic API key (ANTHROPIC_API_KEY in Render).")
    topic = (topic or "").strip()[:500]
    if len(topic) < 3:
        raise ScriptError("Tell me what you want to talk about first.")
    seconds = min(LENGTHS, key=lambda n: abs(n - int(seconds or 30)))
    words = round(seconds * WORDS_PER_SECOND)

    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    today = datetime.date.today().strftime("%B %d, %Y")
    prompt = (
        f"Today is {today}. Write a {seconds}-second script (about {words} spoken words in total, "
        f"never more than {words + 10}) about:\n\n{topic}\n\n"
        "First search the web for the latest news and numbers on this topic. Then reply with ONLY these "
        "five lines, each starting with its label:\n"
        "TITLE: a 3-6 word title for the creator's reference (not spoken)\n"
        "HOOK: ...\nOBJECTION: ...\nPROBLEM: ...\nSOLUTION: ...\n"
        + ("For a 15-second script keep each part to one short sentence.\n" if seconds <= 15 else "")
    )
    messages = [{"role": "user", "content": prompt}]
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 4}]
    sources: list[dict] = []
    text = ""
    try:
        for _ in range(4):  # resume if the server-side search loop pauses
            resp = client.beta.messages.create(
                model=config.CLAUDE_MODEL, max_tokens=16000, system=SYSTEM,
                output_config={"effort": "medium"}, tools=tools, messages=messages,
                # If the main model declines, the API retries on a fallback model in the same call.
                betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            )
            for block in resp.content:
                if block.type == "web_search_tool_result" and isinstance(block.content, list):
                    for r in block.content:
                        if getattr(r, "url", None) and all(s["url"] != r.url for s in sources):
                            sources.append({"title": getattr(r, "title", "") or r.url, "url": r.url})
            if resp.stop_reason == "pause_turn":
                messages = [{"role": "user", "content": prompt}, {"role": "assistant", "content": resp.content}]
                continue
            break
    except anthropic.AuthenticationError:
        raise ScriptError("The Anthropic API key in Render isn't valid.")
    except anthropic.RateLimitError:
        raise ScriptError("The AI is busy right now — wait a minute and try again.")
    except anthropic.APIConnectionError:
        raise ScriptError("Couldn't reach the AI service. Please try again.")
    except anthropic.APIStatusError as exc:
        raise ScriptError(f"The AI service had a problem ({exc.status_code}). Please try again.")
    if resp.stop_reason == "refusal":
        raise ScriptError("The AI couldn't write about that topic. Try wording it differently.")
    text = "\n".join(b.text for b in resp.content if b.type == "text")
    out = _parse(text)
    script = "\n\n".join(out[p.lower()] for p in PARTS)
    out.update({"seconds": seconds, "script": script,
                "words": len(script.split()), "sources": sources[:5]})
    return out
