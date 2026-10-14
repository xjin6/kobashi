import json
import re
import sys


BLOCKED_COMMAND = re.compile(
    r"(pkill|killall)[^|;&]*(kobashi|Kobashi\.app|Claude\.app)"
    r"|kill\s+(-[A-Za-z0-9]+\s+)*[0-9]+[^\n]*kobashi"
    r"|launchctl\s+kickstart\s+[^\n;]*-k[^\n;]*kobashi"
    r"|(Stop-Process|taskkill)[^|;&\n]*(kobashi|Claude(?:\.app|\.exe)?)",
    re.IGNORECASE,
)


def command_from_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("hook input must be an object")
    arguments = payload.get("tool_input", payload.get("toolArgs"))
    if isinstance(arguments, str):
        arguments = json.loads(arguments)
    if not isinstance(arguments, dict) or not isinstance(arguments.get("command"), str):
        raise ValueError("hook input must contain a command string")
    return arguments["command"]


def main():
    try:
        command = command_from_payload(json.load(sys.stdin))
    except (ValueError, TypeError) as error:
        print(f"BLOCKED: could not read the command for the Kobashi safety check: {error}", file=sys.stderr)
        return 2
    if BLOCKED_COMMAND.search(command):
        print(
            "BLOCKED: this command would stop Kobashi or Claude Desktop. "
            "Ask the user to quit and relaunch it themselves. See CLAUDE.md.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
