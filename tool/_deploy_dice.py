import os
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(
    "76.13.14.1",
    username="root",
    password=os.environ["SSH_PASS"],
    timeout=25,
    allow_agent=False,
    look_for_keys=False,
)
sftp = c.open_sftp()
sftp.put(
    r"d:\work\play\backend\games\dice\DiceEngine.js",
    "/root/home/neuria/backend_pok/games/dice/DiceEngine.js",
)
sftp.close()
cmd = r"""
grep -n "BASE_PAY_SCALE\|FREESPIN_PAY_SCALE" /root/home/neuria/backend_pok/games/dice/DiceEngine.js | head -8
pm2 restart 4 --update-env
sleep 1
pm2 jlist | python3 -c "import json,sys; d=json.load(sys.stdin); x=[p for p in d if p.get('pm_id')==4][0]; print(x['name'], x['pid'], x['pm2_env']['status'])"
"""
stdin, stdout, stderr = c.exec_command(cmd, timeout=40)
out = stdout.read().decode("utf-8", "replace")
err = stderr.read().decode("utf-8", "replace")
open(r"d:\work\play\backend\_deploy_dice.txt", "w", encoding="utf-8").write(out + "\n---ERR---\n" + err)
c.close()
print("done")
