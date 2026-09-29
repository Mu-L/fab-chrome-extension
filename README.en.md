# Fab Content Downloader

[中文](README.md) | **English**

> ⚠️ AI Slope
>
> This is a pure vibe-coded, low-maintenance, throw-away project. It is not an
> official Epic Games or Fab product, it will not be published on the Chrome Web
> Store, and there is no guarantee of continued updates, compatibility or support.
>
> Use at your own risk.
>
> Only download content you are entitled to. You are responsible for judging and
> bearing the risks to your account, your data, licences, platform terms and
> local files.
>
> If anything is unclear, point your AI at [SPECS.md](SPECS.md).

![image-example](./images/page-example.webp)

## What does it do?

A fair amount of UE content cannot be downloaded from the Fab website. You have
to install the Epic Games Launcher — which may break on any given day — install a
specific engine version and create a project of that specific version, all just
to download one asset pack. Apparently Epic thinks we are too stupid to know
which version we want.

Anyway: load this extension into Chrome and you can browse your Fab UE library
and download any version to your local disk.

## Requirements

- Desktop Chrome 103 or newer.
- An Epic Games / Fab account that can log in normally and already owns the
  content in question.
- Enough disk space and free memory to hold the download.
- A tool that can extract `.tar` files.

The Epic Games Launcher and Unreal Engine are **not** required.

## Usage

### Install

1. Download and extract the full project, and check that `manifest.json` sits at
   the root of the directory.
2. Open `chrome://extensions/` in Chrome.
3. Turn on **Developer mode** in the top right.
4. Click **Load unpacked** and select the directory containing `manifest.json`.
5. Optional: pin the extension to the toolbar.

There is no Chrome Web Store build. To update, replace the whole extension
directory and then reload the extension in `chrome://extensions/`.

### Download

1. Log in on the Fab website first.
2. Click the extension icon, then click **Login with Epic Games**.
3. Once logged in, click **Open Library**.
4. Find the asset in the library and select the version you need.
5. Click download and grant the extension write access to the local directory
   you choose.
6. The result is a `.tar` file — inspect and extract it yourself.

## License

GPL-3.0
