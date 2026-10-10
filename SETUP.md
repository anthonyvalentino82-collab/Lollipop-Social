# Setting up LolliPOP Social (no coding needed)

This guide takes you from "code on GitHub" to "app icon on my iPhone." It takes about 30 minutes, and you only do it once.

You'll create a few free accounts, copy some secret keys, and paste them into a hosting website. You won't need to write any code.

---

## What you're setting up, in plain English

| Piece | What it does | Cost |
|---|---|---|
| **Render.com** | The computer in the cloud that runs your app and builds your videos | about **$25–28/month** |
| **OpenAI** | Listens to your video and writes the captions | about **$0.006 per minute** of video (a 1-minute video costs less than 1 cent) |
| **Pixabay** | Free stock video library used for Auto B-roll | **Free** |
| **Anthropic (Claude)** — *optional* | Picks better B-roll moments and search words | about **1–2 cents per video** |

Everything else runs inside your app at no extra cost: the AI person cut-out for the headline, face tracking for zoom, audio cleanup, and the video encoder.

**Nothing paid is switched on until you add its key.** Without an OpenAI key, captions use a free transcriber built into the app. It's slower and needs the bigger Render plan. Without a Pixabay key, B-roll only uses clips you upload yourself.

---

## Step 1 — Get your keys (copy each one into a note as you go)

### 1a. OpenAI key (for captions)
1. Go to **platform.openai.com** and sign up or log in.
2. Click **Settings → Billing** and add a payment method. Add **$5** of credit, which covers hundreds of videos.
3. Click **API keys → Create new secret key**. Name it "LolliPOP" and copy the key (it starts with `sk-`).
   You only see the key once, so paste it into your note right away.

### 1b. Pixabay key (for B-roll — free)
1. Go to **pixabay.com** and tap **Join** to create a free account (or log in).
2. Go to **pixabay.com/api/docs**.
3. Scroll down to the **Parameters** section. Your key appears there in green, next to the word `key` (a long mix of numbers and letters).
4. Copy it into your note.

*(Pexels also works, if you already have a Pexels key. Pexels has paused new keys for now.)*

### 1c. (Optional) Anthropic key (smarter B-roll picks)
1. Go to **console.anthropic.com** and sign up.
2. Add $5 of credit under **Billing**.
3. Under **API Keys**, click **Create Key** and copy it (it starts with `sk-ant-`).

### 1d. Choose an app password
Make up a password that you'll type on your iPhone the first time. Anyone who has your app's web address and this password can use your app (and your paid keys), so make it long.

---

## Step 2 — Make sure the code is on GitHub
The code lives in your GitHub repository **lollipop-social**. If Claude pushed it to a branch other than `main`, open the repository on github.com and either merge the pull request, or note the branch name for Step 3.

---

## Step 3 — Put the app online with Render
1. Go to **render.com** and click **Get Started**. Choose **Sign up with GitHub**.
2. When Render asks, allow it to see your **lollipop-social** repository.
3. In the Render dashboard, click **New + → Blueprint**.
4. Pick the **lollipop-social** repository (and the branch from Step 2). Render reads the `render.yaml` file and sets everything up.
5. Render asks for a few values. Paste the keys from Step 1:
   - `APP_PASSWORD`: your password
   - `OPENAI_API_KEY`: your OpenAI key
   - `PIXABAY_API_KEY`: your Pixabay key
   - `PEXELS_API_KEY`: leave blank (unless you have one)
   - `ANTHROPIC_API_KEY`: your Anthropic key, or leave it blank
6. Click **Apply** or **Create**. The first build takes about 10–15 minutes. When the status says **Live**, you're done.
7. At the top of the page, Render shows your app's address, for example `https://lollipop-social.onrender.com`.

**About the plan:** the blueprint picks Render's **Standard** plan (2 GB memory, $25/month) plus a 10 GB disk ($2.50/month) that keeps your logos and projects. The cheaper "Starter" plan doesn't have enough memory to build 1080p videos. If renders feel slow, you can upgrade to **Pro** in Render's settings at any time; each step up roughly doubles the speed.

To change a key later: Render dashboard → your service → **Environment** → edit → **Save**. The app restarts by itself.

---

## Step 4 — Put it on your iPhone
1. On your iPhone, open **Safari** and go to your Render address.
2. Type your password and tap **Unlock**.
3. Tap the **Share** button (the square with an arrow), then **Add to Home Screen**, then **Add**.

You now have a LolliPOP icon that opens the app full-screen, like a normal app.

---

## Step 5 — Make a video
1. Tap **Record video** (opens your front camera) or **Choose from library**.
2. Wait for "Video ready," then tap **Auto Edit**. In about a minute it:
   - cleans up your voice
   - writes captions
   - finds zoom moments
   - picks B-roll
3. Adjust anything you like:
   - **Trim**: cut the start and end.
   - **Captions**: fix words, change the font, color, size or position. You can also drag the captions on the preview.
   - **Headline**: type your big headline. Put `*stars*` around words to make them red. It appears **behind** you.
   - **Logo**: pick LolliPOP, or tap **+ Add logo** to upload your Horizon Pacific Lending PNG. Drag it, pinch to resize, then tap **★ Save as my default**.
   - **Music**: choose an MP3/M4A from your Files app and set the volume. The music lowers itself automatically while you talk.
   - **Zoom**: turn it on or off and choose the strength.
   - **B-roll strip**: tap **Remove** on clips you don't want, or **Swap** to get a different one.
4. Tap **Save Video**. When it finishes, tap **Save to iPhone / Share → Save Video** to put it in Photos. From the same menu you can also send it to Messages, Instagram, TikTok, Facebook, LinkedIn or YouTube.

### Camera tips for best results
- Hold the phone **vertically**.
- iPhone **Settings → Camera → Record Video → 1080p at 30 fps** keeps uploads small and fast.
- Keep your head and shoulders in frame, with some space above your head for the headline.
- A plain background makes the "headline behind me" cut-out look best.

---

## Licensing — what you're allowed to do
- **Pixabay / Pexels B-roll:** free for commercial use and no credit required. You may not imply that the people in the footage endorse your business, and you may not resell the clips on their own.
- **Music:** you must own or license any music you add. Songs bought or streamed on Apple Music/Spotify can't be loaded (they're copy-protected), and Instagram or TikTok may mute copyrighted songs. Use royalty-free music, for example from **pixabay.com/music** (free) or **Artlist/Epidemic Sound** (paid subscriptions).
- **Fonts** (Anton, Montserrat, etc.): Open Font License, free to use in videos.
- **AI models and ffmpeg:** open source (Apache 2.0 / LGPL / GPL). Free to use for your own app.

---

## Troubleshooting
- **"Captions: transcription failed"**: your OpenAI key is missing, mistyped or out of credit. Check Render → Environment, and OpenAI → Billing.
- **"B-roll: add a PIXABAY_API_KEY…"**: add the Pixabay key in Render → Environment.
- **The app asks for the password again**: that's normal after clearing Safari data.
- **Upload is slow**: record at 1080p/30fps instead of 4K.
- **Something else**: Render dashboard → your service → **Logs** shows what happened. Copy the last red lines and paste them to Claude.

## Running it on your own computer (optional, for testing)
You'll need Python 3.11 and ffmpeg installed. Then run these commands in a terminal:
```
pip install -r requirements.txt
cp .env.example .env        # then edit .env and add your keys
export $(grep -v '^#' .env | xargs)
uvicorn app.main:app --host 0.0.0.0 --port 8000
```
Open http://localhost:8000. Your iPhone can use `http://<your-computer's-IP>:8000` if it's on the same Wi-Fi.
