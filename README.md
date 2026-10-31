# webagent
Outline of project:
To run a fully extension-native AI browser agent without spending a dime, you need a tech stack where every single component offers a generous, zero-cost developer tier.
By swapping out expensive enterprise choices for developer-friendly free APIs, you can build a highly capable click-and-reason loop that runs entirely on free credits.

🧠 1. The Core AI Engine — Reasoning & Prompt Generation

Instead of OpenAI or Anthropic (which require a paid balance or credit card verification up front), you can use providers that offer robust, unmetered or generous free tiers.
• Google AI Studio (Gemini API Key): The Best Choice. Google provides a generous free tier for its efficient models. Using an API key for Gemini 2.5 Flash or Gemini 3.5 Flash-Lite allows you to feed thousands of lines of raw GitHub code directly into the model without hitting credit caps.
	• Free Limit: Free accounts can make multiple requests per minute, making it ideal for processing text context and writing refactoring prompts. [1] (/goto?url=CAESaQHrOzAV_T52_r5jfKDZ2BYIMbTCidMAFld3i4dPvC44hJNBVGaahadKgJ-WhBHhG64-HP-UeIP5_Cf_ngvc9K2FgSmEDoYJTKEZR1QCXhlYtyfiN24CgAMUW9atwrp6r9HCh5x3D25Mug), [2] (https://aistudio.google.com/docs/pricing), [3] (/goto?url=CAESlgEB6zswFS9P6kW3O21VdHbXXnO7bsBx5xocESLbuaXfprYVnLQvfMTl01I6_lLeL_FD218826FS36-56y0Y0M1WW0jWKfqFI0ThycblKzOE5kRr7BBMM0CNM8kv66mgc3XnU-gJvtb00VeYj_JIR4Y0MwvjazyEW8eTc3em_WE2r0h53XNYrpewdTntpw8N9Du05vgxybU), [4] (/goto?url=CAESpAEB6zswFZM1wt6dpq0iQbOdIXJlTuIhIoD_ua1WsLwsNLnoYlEwwN5k3R-QRGrbv-aHXKjq5y9AlEPBAXgl7oYk3TFuamURJ2EYtu9Tb5gyuH5Y9hvl-9qEsvM01cl0TUa2k5ZTaimfyAEobROZLfKFz_QoM39uky75D1za-9Lkd3u9DObKTm6JU8MXQH23fp0OXFJRBa0fqVxZLYxDXsQxpztKSw)
• Groq API Key: If you want hyper-fast text generation, Groq provides a completely free developer tier for open-source models like Llama 3. It handles reasoning tasks almost instantly, though it lacks native multi-modal image support.

👁️ 2. Visual Element Recognition — "Seeing" The Click Targets

To prevent the extension from guessing blindly, you need an API that accepts a page screenshot and returns coordinate bounding boxes for every button and input field.
• Roboflow API Key (Free Tier): The Best Choice. Roboflow offers a highly functional developer Free Tier that gives you 10 rolling credits per month.
	• Free Limit: This credit allotment translates to roughly 80,000 free cloud inferences when running lightweight target-detection models like RF-DETR Nano. You can use this to visually map out web interfaces like v0 or Bolt.new for free. [1] (/goto?url=CAESVAHrOzAVAQXB2PkOG_ouPG-r6HDGDm3pm8J0xLVbQXmTJy8wT5_Q66yfH5arXDjtC2HofGwdBU1PnOGu2UQG2BkQvxlzxxGV-4mEKY-Ui1wKCPK2yg), [2] (/goto?url=CAEScgHrOzAVQGz0iGB6ofbc1uquhripyewcMD95lYBMCtH6GssLcNshEXgBhURog3sfAXTlyK4EhMHkbk36ohvtga1auWk-pjSPnbeotNUaYtVpG4RXNNrleWiZxh598Ix7ijk7vSxwuvYLE-oCZNbBAFgeTA), [3] (/goto?url=CAESggEB6zswFSP7SL9IRk6ToxlLHPaY3kSzoyKDLiaw2eivypvlFj5WPEMitvDB5yHWZHLEWVx10QCA4dZNzHau_9NAlD0_9ffbp0BgUx8GBY8Cpp_pfPn5ZD-yxP5t_q1CTEYPNEkTGFOERaEhtUhdtISwUEYmMc5-BhRrlvoPkd4RvB2R)
• Hugging Face Inference API (Free): You can call open-source UI segmenters (like Microsoft's OmniParser v2.0 or Florence-2) hosted directly on Hugging Face's free public inference spaces. It requires no token balance, though response times can occasionally fluctuate based on public queue traffic. [1] (/goto?url=CAESaAHrOzAV1qNQpxUMWFiBzK_XbEC-dLjUw64IZMlkg5CScajGFbJhnx39VkLp4zV92tJZ_77DFszxPOX9E5-itdCcOK1p4IYjsxBfjdUiv0WB2FIkyimgbislHr8ojrDQsPtGLmNUlLGv)

🕹️ 3. Execution & Navigation — The Free Extension Protocols

You do not need a paid service or external API keys to control the browser tab. Google Chrome builds these system automation capabilities natively into the extension architecture for free.
• The Chrome Debugger Protocol (unset chrome.debugger ): A built-in browser runtime feature. When your extension activates this debugging layer on a tab, it unlocks low-level hardware emulation entirely offline.
	• Mouse Events: Dispatches hardware-level Input.dispatchMouseEvent actions to programmatically click exact (X, Y) coordinates, bypassing security blocks on modern React web apps.
	• Keyboard Events: Uses Input.dispatchKeyEvent to accurately simulate keyboard inputs character-by-character into text fields.
• The Chrome Scripting Protocol (unset chrome.scripting ): A free extension mechanism that injects an invisible data collector into your open GitHub tab to scrape the page text (document.body.innerText) natively in milliseconds.

🛠️ The No-Cost Blueprint Architecture

When configured together inside your custom extension, your fully free agent pipeline operates through this local loop:
mermaid
graph TD
    A[User clicks 'Go' in Sidebar UI] --> B[chrome.scripting reads raw GitHub text context locally]
    B --> C[Gemini Flash API analyzes text & builds refactor prompt for FREE]
    C --> D[chrome.tabs spawns target webcoding agent site e.g., v0.dev]
    D --> E[chrome.debugger snaps a layout screenshot image]
    E --> F[Roboflow API maps out element bounding boxes via free credits]
    F --> G[Gemini reads layout boxes & identifies text input box coordinates]
    G --> H[CDP inputs mouse clicks & character strings into the workspace autonomously]

#We will add a cloudflare worker and d1 database for signups, and data storage, and API storage. This must be a fucntionaing extension for chrome web store, and be able to download aas a ZIP file form some artifact or check ro something so that I can preview in chroem://extensions developer mode
Use code with caution.
Would you like the complete JavaScript code block to initialize the chrome.debugger protocol and connect it to a free Gemini API call? I can provide the ready-to-use boilerplate.
