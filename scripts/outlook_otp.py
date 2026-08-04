from __future__ import annotations

import calendar
import email
import email.utils
import imaplib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"
IMAP_HOST = "outlook.office365.com"
OPENAI_SENDERS = ("openai.com", "auth.openai", "tm.openai", "chatgpt.com", "tm.open")


class FatalMailError(RuntimeError):
    pass


def get_access_token(refresh_token: str, client_id: str) -> dict:
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
        "scope": IMAP_SCOPE,
    }).encode()
    request = urllib.request.Request(TOKEN_URL, data=body)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        if error.code in (400, 401, 403):
            raise FatalMailError(f"Outlook OAuth refresh failed ({error.code}): {detail}") from error
        raise
    if not data.get("access_token"):
        raise FatalMailError(f"Outlook OAuth response has no access_token: {data}")
    return data


def is_hex_context(text: str, index: int) -> bool:
    if index > 0 and text[index - 1] == "#":
        return True
    prefix = text[max(0, index - 30):index]
    return bool(re.search(r"(?:color|background|bgcolor|fill|stroke)\s*[:=]\s*[\"']?#?\s*$", prefix, re.I))


def extract_otp(body: str) -> str | None:
    patterns = (
        r"(?:code(?:\s*is)?|verification|one[-\s]*time|verify|kode|verifikasi|代码|验证码|驗證碼)[^\d<>]{0,80}(\d{6})\b",
        r"chatgpt[^\d<>]{0,80}(\d{6})",
        r"openai[^\d<>]{0,80}(\d{6})",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, body, re.I | re.S):
            if not is_hex_context(body, match.start(1)):
                return match.group(1)
    for match in re.finditer(r"\b(\d{6})\b", body):
        if not is_hex_context(body, match.start(1)):
            return match.group(1)
    return None


def message_timestamp(fetch_meta: bytes, message: email.message.Message) -> float:
    try:
        parsed = imaplib.Internaldate2tuple(fetch_meta)
        if parsed:
            return float(calendar.timegm(parsed))
    except Exception:
        pass
    try:
        parsed_date = email.utils.parsedate_to_datetime(message.get("Date") or "")
        return parsed_date.timestamp()
    except Exception:
        return 0.0


def message_body(message: email.message.Message) -> str:
    parts: list[str] = []
    for part in message.walk():
        if part.get_content_type() not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_payload(decode=True) or b""
            parts.append(payload.decode(part.get_content_charset() or "utf-8", errors="replace"))
        except Exception:
            continue
    return "\n".join(parts)


def discover_folders(client: imaplib.IMAP4_SSL) -> list[str]:
    defaults = ["INBOX", "Junk", "Junk Email", "Spam"]
    try:
        _, listing = client.list()
        names: dict[str, str] = {}
        for raw in listing or []:
            text = raw.decode(errors="ignore") if isinstance(raw, bytes) else str(raw)
            match = re.search(r'"([^"]+)"\s*$', text) or re.search(r"\s(\S+)\s*$", text)
            if match:
                name = match.group(1).strip('"')
                names[name.lower()] = name
        folders = [names[name.lower()] for name in defaults if name.lower() in names]
        folders.extend(value for key, value in names.items() if any(x in key for x in ("junk", "spam", "bulk")) and value not in folders)
        if "INBOX" not in folders:
            folders.insert(0, "INBOX")
        return folders
    except Exception:
        return defaults


def fetch_otp(config: dict) -> str:
    address = str(config["email"]).strip()
    client_id = str(config["client_id"]).strip()
    refresh_token = str(config["refresh_token"]).strip()
    not_before = float(config.get("not_before") or time.time())
    timeout_sec = int(config.get("timeout_sec") or 0)
    interval = max(1, int(config.get("poll_interval_sec") or 5))
    deadline = time.time() + timeout_sec if timeout_sec > 0 else None
    cached_token = ""
    cached_refresh = refresh_token
    token_at = 0.0
    folders: list[str] | None = None
    seen: set[tuple[str, bytes]] = set()

    while deadline is None or time.time() < deadline:
        try:
            if not cached_token or time.time() - token_at > 3000:
                token_data = get_access_token(cached_refresh, client_id)
                cached_token = token_data["access_token"]
                cached_refresh = token_data.get("refresh_token") or cached_refresh
                token_at = time.time()

            client = imaplib.IMAP4_SSL(IMAP_HOST, 993)
            auth = f"user={address}\x01auth=Bearer {cached_token}\x01\x01"
            status, _ = client.authenticate("XOAUTH2", lambda _: auth.encode())
            if status != "OK":
                raise FatalMailError("Outlook IMAP XOAUTH2 authentication failed")
            folders = folders or discover_folders(client)

            for folder in folders:
                folder_arg = f'"{folder}"' if " " in folder else folder
                if client.select(folder_arg, readonly=True)[0] != "OK":
                    continue
                status, search_data = client.search(None, "ALL")
                if status != "OK":
                    continue
                ids = search_data[0].split() if search_data and search_data[0] else []
                for message_id in reversed(ids[-12:]):
                    key = (folder, message_id)
                    if key in seen:
                        continue
                    seen.add(key)
                    status, raw = client.fetch(message_id, "(BODY.PEEK[] INTERNALDATE)")
                    if status != "OK" or not raw or not isinstance(raw[0], tuple):
                        continue
                    message = email.message_from_bytes(raw[0][1])
                    received_at = message_timestamp(raw[0][0], message)
                    if not received_at or received_at <= not_before:
                        continue
                    sender = (message.get("From") or "").lower()
                    if not any(domain in sender for domain in OPENAI_SENDERS) or "tm1.openai" in sender:
                        continue
                    code = extract_otp(message_body(message))
                    if code:
                        try:
                            client.logout()
                        except Exception:
                            pass
                        return code
            try:
                client.logout()
            except Exception:
                pass
        except FatalMailError:
            raise
        except Exception as error:
            message = str(error).lower()
            if any(term in message for term in ("invalid_grant", "invalid_client", "authentication failed", "authenticate failed", "xoauth2")):
                raise FatalMailError(f"Outlook account cannot receive mail: {error}") from error
        time.sleep(interval)
    raise TimeoutError(f"Outlook OTP timeout for {address}")


def main() -> int:
    try:
        if "--self-test" in sys.argv:
            assert extract_otp("OpenAI verification code is 123456") == "123456"
            assert extract_otp("background:#353740") is None
            print(json.dumps({"ok": True, "self_test": True}))
            return 0
        config = json.loads(sys.stdin.read() or "{}")
        code = fetch_otp(config)
        print(json.dumps({"ok": True, "code": code}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
