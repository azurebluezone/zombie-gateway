# environment.md — মেশিন, মডেল, কনফিগ (পুনর্নির্মাণের দলিল)

> মাপা হয়েছে ২০২৬-১০-১৯-এ, লাইভ সিস্টেম থেকে। সংখ্যা বদলাতে পারে, কমান্ড একই থাকবে।

---

## ১. মেশিন

| বিষয় | মান |
|---|---|
| OS | Ubuntu 22.04.5 LTS (Xubuntu ডেস্কটপ) |
| Kernel | `6.8.0-40-generic` |
| Python | `3.10.12` (সিস্টেম python3-ই যথেষ্ট — **কোনো pip install নেই**) |
| CPU | 4 cores |
| RAM | 15 Gi |
| GPU | নেই (nvidia কনট্রোলার **0**) — সব CPU-তে চলে |
| ডিস্ক `/` | লাইভ-USB `/cow` overlay · ৭.৮ G মোট, **২.৪ G ফাঁকা** (সাবধান!) |

## ২. ollama

```bash
$ curl -s http://127.0.0.1:11434/api/version
{"version":"0.40.6"}

$ curl -s http://127.0.0.1:11434/api/tags
deepseek-r1:1.5b    1.12 GB   1.8B
qwen3.5:0.8b        1.32 GB   752.39M
llama3.2:latest     2.02 GB   3.2B
```

### মডেল-স্টোর (zero-duplication হাব)

লাইভ-USB-এর `/cow`-এ মাত্র ~২.৬ GB ফাঁকা, অথচ মডেল লাগে ~৪.৫ GB। তাই মডেল-স্টোর
বড় ext4 ড্রাইভে, আর সেখানে **manifest কপি + blob symlink** — এক বাইটও দুইবার নেই:

```
/media/xubuntu/759e9d2f-b1e3-48c7-9e24-dc98181febf1/ollama-models   (287 GB ড্রাইভ, 243 GB ফাঁকা)
├── manifests/…   ← কপি করা (ছোট, কয়েক KB)
└── blobs/…       ← symlink, আসল বাইট অন্যত্র
```

হাবটা নিজে মাপে মাত্র **200 KB** — কারণ ব্লবগুলো symlink। শূন্য থেকে বানাতে হলে:

```bash
HUB=/media/xubuntu/759e9d2f-b1e3-48c7-9e24-dc98181febf1/ollama-models
mkdir -p "$HUB/manifests" "$HUB/blobs"
cp -r ~/.ollama/models/manifests/* "$HUB/manifests/"
for b in ~/.ollama/models/blobs/*; do ln -s "$b" "$HUB/blobs/$(basename "$b")"; done
```

নতুন মেশিনে সবচেয়ে সহজ পথ (symlink-ঝামেলা ছাড়া): `ollama pull deepseek-r1:1.5b`,
`ollama pull qwen3.5:0.8b`, `ollama pull llama3.2:latest`।

## ৩. সিস্টেম-কনফিগের হুবহু কপি

### `/etc/systemd/system/ollama.service.d/override.conf`

```ini
# ============================================================
# ZombieCoder — Ollama tuned for a Live-USB / no-hard-disk setup.
# Created: 2026-10-18
# Rollback: sudo rm -rf /etc/systemd/system/ollama.service.d && sudo systemctl daemon-reload && sudo systemctl restart ollama
# ============================================================
[Service]
# 1) Model store lives on the big ext4 drive (243 GB free) — NOT on the
#    live-USB overlay (/cow has only ~2.6 GB free). Merged symlink hub.
Environment="OLLAMA_MODELS=/media/xubuntu/759e9d2f-b1e3-48c7-9e24-dc98181febf1/ollama-models"
# 2) Keep models resident in memory/RAM-cache instead of unloading after 5 min.
Environment="OLLAMA_KEEP_ALIVE=-1"
# 3) Flash-attention + explicit context window (matches gateway NUM_CTX=8192).
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_CONTEXT_LENGTH=8192"
# 4) Up to two models stay hot at once (llama3.2:latest + a small one).
Environment="OLLAMA_MAX_LOADED_MODELS=2"
```

**রোলব্যাক:** `sudo rm -rf /etc/systemd/system/ollama.service.d && sudo systemctl daemon-reload && sudo systemctl restart ollama`

### `/etc/sudoers.d/modellab` (সংকীর্ণ root-সাহায্যকারী)

```
# Model Lab — narrow privileged reader (added by install_proc_helper.sh)
xubuntu ALL=(root) NOPASSWD: /usr/local/lib/modellab/proc_report.py
```

কেন লাগে: `/proc/<llama-server-pid>/maps` আরও `/smaps_rollup` ptrace-gated — সাধারণ
ইউজার (এমনকি `ollama` গ্রুপে থাকলেও) পড়তে পারে না। ওয়েব-সার্ভারকে root বানানোর বদলে
**একটাই সংকীর্ণ স্ক্রিপ্ট** root-এ চলে, শুধু ওই তথ্য পড়ে।
**সরানোর উপায়:** `sudo bash install_proc_helper.sh --remove`

## ৪. পোর্ট, ঠিকানা, ঝুঁকি

| জিনিস | মান |
|---|---|
| ollama | `127.0.0.1:11434` |
| Model Lab UI/API | `127.0.0.1:8765` (ডিফল্ট) · `MODEL_LAB_BIND=0.0.0.0` দিলে নেটওয়ার্কে খুলবে |
| ক্লাউড গেটওয়ে (অচালানো) | `https://gpu.zombiecoder.my.id` |
| auth | **নেই** — মালিকের নির্দেশে (একজনই ব্যবহারকারী)। তাই ডিফল্ট লোকাল-বাইন্ড। |

> ⚠️ `0.0.0.0`-এ বাইন্ড করলে auth-হীন shell টুলও নেটওয়ার্কে খুলে যায় — ইচ্ছাকৃতভাবে
> ডিফল্ট `127.0.0.1` রাখা হয়েছে।

## ৫. গুরুত্বপূর্ণ পাথ (এক নজরে)

```
/home/xubuntu/Documents/Default Project/          ← ল্যাব (এই আর্কাইভের project/ হুবহু এটার কপি)
  model_lab_server.py · model_tools.py · static/ · workspace/
  dialect_lab.py · parse_layers_test.py · README.md
  lab_data/dialect_memory.json                    ← শেখা ডায়ালেক্ট (লাইভ ইনপুট)

/tmp/opencode/                                    ← ক্যাপচার-টুলিং ও কাঁচা SSE (evidence/ কপি)
/media/xubuntu/759e9d2f-…/ollama-models           ← মডেল-হাব (symlink-মার্জড)
/etc/systemd/system/ollama.service.d/override.conf
/etc/sudoers.d/modellab
```

## ৬. পরিবেশ-ভেরিয়েবল

| নাম | ডিফল্ট | কাজ |
|---|---|---|
| `MODEL_LAB_PORT` | `8765` | ল্যাবের পোর্ট |
| `MODEL_LAB_BIND` | `127.0.0.1` | বাইন্ড-ঠিকানা (নিরাপত্তার জন্য লোকাল) |
| `MODEL_LAB_ALLOW_INTERPRETERS` | নেই | `1` করলে `python3`/`bash` জাতীয় ইন্টারপ্রেটার অনুমোদিত |
| `MODEL_LAB_OLLAMA` | `http://127.0.0.1:11434` | ollama-র ঠিকানা |
| `OLLAMA_MODELS` | (উপরে) | মডেল-স্টোরের পথ |
