In the MAIN_FOLDER (inside the CHANNEL_FOLDER folder) there are A-roll(s) of the video which I would like you to edit and create a final video output to be uploaded to Youtube.

Style:
The style details for this channel and this VIDEO_TYPE are given in the CHANNEL_STYLE section at the end of these instructions, use this to create text content etc.

If CHANNEL_STYLE is empty, design a fitting style yourself, use it for this video, and save it in CHANNEL_FOLDER/Style/STYLE.md (create the Style folder when it is missing) so it can be used for future videos. If CHANNEL_STYLE has a style, never create a Style folder or a STYLE.md.

A-roll:
A-rolls are the video files in MAIN_FOLDER itself. The audio of the output video comes directly from it. Try to keep the A-roll cuts to shorter duration when there can be a video b-roll or programmatically created b-roll possibility.

In A-roll, when the host is looking down (maybe, to read some specs etc. ) or not looking in the camera, it is preferred that we use a b-roll there.

If and when there is one A-roll for a host and another A-roll for a phone or a tablet screen recording. Make sure you show the host when the host is talking to the camera, but when the host is doing something on phone/tablet, you show the tablet and phone together on screen., Keep the tablet app in full view. Do not zoom on the tablet. Do highlight the parts which the host is talking about on the app. Also, put the host next to the phone/tablet in that circle. Make sure the full height of the host video takes the full height of the circle (no zoom).

B-roll:
There is a B-roll folder named BROLL_FOLDER in the MAIN_FOLDER. BROLL_FOLDER may have some more sub folders for product specific b-rolls. BROLL_FOLDER may be completely absent or empty as well. In that case, create your own b-rolls with programming. Files in the b-rolls are named in a way which tells what is there in the b-roll. These can be images or videos. Use them when you think is appropriate, in the video. Try to use various types of motions/transitions/effects/parallax etc. on images so that they don't look like static images in the video. 

Some of the b-rolls may require stabilization. If you think they do, stabilize them before using them as b-roll.

Create B-rolls Programmitically:
Create lots of full screen B-rolls with animations which can be used for various cuts in the video. These B-rolls must be created programmatically. These should be consistent animation in that and should never be static/stationary, whether it is just text or some kind of animation. 

It is good practice that every start of a new sentence, you show the host (A-roll) for a few seconds and then go to b-roll. Try not to repeat a b-roll. If you have to repeat a b-roll, do not repeat it more than 2 times. When no b-roll is available for a specific scene/part, create a B-roll programmatically to enhance the video (like title, graphs, animations, etc.). Make sure none of the broll which is shown on top of a-roll comes over the head/face/body of the host.

Product B-Roll from Links:
If there are some links provided in the PRODUCT_LINKS section, create additional b-rolls from the product images from provided links from the PRODUCT_LINKS section. Make sure you edit the images, if possible remove the background and give some back shadow etc. and make it look different. If there are no links, just ignore this section. Pick up around 2 to 3 images of the products and try to use them in b-roll. Make sure images take up good amount of screens size when shown.

Screen Recording Video:
If there is a computer screen, phone screen or tablet screen recording A-roll for the full length of the video, we call it screen recording video. There may or may not be a host a-roll video for this. 
Computer Screen Recording: If it is a computer screen recording, we show the host when the host is talking to the camera and screen when he/she is doing something on the screen. We add text extra over text etc. over it with a proper background to make it look clean.
Phone or Tablet Screen Recording: If host video is also available in A-roll, we edit it like computer screen video, but show the full phone/tablet screen recording  and the host next to each other. We zoom on the one the screen of the phone/tablet to emphasize and market specific sections of the screen. We show the host in the left/right corner in some good looking circular area. If a host video is not present we simply show the recording screen and insert our programmatically created text etc. on the top of it.

Long vs Short Videos:
If VIDEO_TYPE is "long", create a landscape 16:9 video, if VIDEO_TYPE is "short" then create a vertical 9:16 video. Preferred length for a "short" video is less than 3 minutes. Never try to exceed it.

For a "short" video, the idea is to give the best points about a product and how it can be useful for the user. The video should be fast paced, factually correct and should be able to hold the user attention till the end of the video.

"Long" videos are mostly explanatory videos which explain the concept or show the products, its features, how it works, its results etc. It should be created in a way that there are fast cuts, so the user does not get bored. Fast cuts can be on a host (A-roll), image or video b-roll, some text on screen with some zoom / animation. 

For long videos, cut tight, removing retakes, mistakes and dead air, and let the content decide the length.

Video Ending:
When ending the video, give a small empty pause of about 0.5 seconds. We can use "Dark Fade" or some other transition for this.

Titles / Text:
When using Texts/Titles, go for BIG and BOLD.
If the video is in Hindi, Hindi words should be written in Hindi (Devanagari), except technical terms, product names, and English words etc.
Do not write the "Channel Name" or "Subscribe" related words in Hindi, anywhere.

Audio:
No background music.
Subtle sound effects like woosh, risers, swipe, swish etc.
The language of the video is to be taken from the A-roll. 

Technical:
Frame rate: Use the frame rate for the final video same as the A-roll. If there are other frame rates for b-roll, convert them.
Audio: the voice should be loudness-normalized to YouTube's standard (-14 LUFS). Do not try any noise reduction or cleanup.
Use all hyperframes skills for b-roll generation and other things, as required.

Review Output:
Before creating the final render, please create a file which can be opened and reviewed in REVIEW_OUTPUT_SOFTWARE. The timeline will be reviewed in this software and changes will be made in that. Based on these changes the final output render must be done. This is very important, this is the only way the feedback by the user will be provided. This review output file should be saved in the "output" folder in MAIN_FOLDER only.

Thumbnail:
Based on the video and the hook of the video, create 5 very different thumbnails for the video to be uploaded on Youtube.
For thumbnails, you can use the host pictures from the video or you can use any of the screenshots from the a-roll or b-roll (of host or product(s)). You can also create text, graphics on it programmatically. Make sure to use BIG and BOLD fonts, with brighter and  high contrast colors.
Thumbnail dimensions should be 1280x720 for long videos and should be 720x1280 for shorts. Thumbnails should be named thumbnail-1.png, thumbnail-2.png, thumbnail-3.png, thumbnail-4.png and thumbnail-5.png
Save these thumbnail files directly in the "output" folder in MAIN_FOLDER only. 

Meta:
Create 5 “Titles”, a “Description” and a set of “tags” (comma separated) for the video, in the meta.txt file, in the "output" folder in MAIN_FOLDER only. These Titles (one of them),  description and tags will be used when uploading the video on Youtube, so optimize them for it.

Final Output:
Final output of the video should be saved in the "output" folder in MAIN_FOLDER only. 
Final output should be a 4K video (H.264) at around 40mbps bitrate. To show the output for approval, create the file for REVIEW_OUTPUT_SOFTWARE. Do, not create the final output until I check the REVIEW_OUTPUT_SOFTWARE file and review it and approve it.
Use hardware encoder and hardware decoder for video encoding/decoding wherever possible, like media encoders on Mac (via VideoToolbox) and CUDA based GPUs (via NVENC and NVDEC) on Windows. I am aware that a CPU can create better quality, but for us, time is of essence. Do NOT do video encoding and decoding on the CPU.

Some Important Points:
Do your best to make videos interesting, engaging and fast paced.
When not on A-roll, something must always be moving on screen. Never show a static frame or static image etc., without motion.
If a host is showing a product in hand or pointing towards a product, do keep A-roll on screen at those times. But make sure it does not run for more than 2 seconds.
Remember, there is no need to transcribe any b-rolls, only A-rolls have the actual audio of the video.

There might be other sessions running in the same directory, so make sure not to use any of the other folders outside the MAIN_FOLDER folder (except TOOLKIT_FOLDER which you can use [but make sure it does not destroy other session’s work]).

Whisper, HyperFrames graphics and ffmpeg may use full cpu or full gpu. If that is happening, please create and release a lock in the repository folder (and NOT in MAIN_FOLDER) with the name cpu.lock or gpu.lock based on which of them you are using to max. That way the other sessions might want to wait before pushing the cpu or gpu. Also, when you want to use the CPU or GPU in full, check for these locks and wait or proceed based on its availability.

Your Working Directory:
If you need to create any other files for this video editing project, create them in the "CLAUDE_VE" named folder in the MAIN_FOLDER. For more future video editing projects, you can store common files/directories (like .venv virtual environment, sfx, gfx etc.) in TOOLKIT_FOLDER in this repository folder. This should be used for all future video editing projects, and no project specific data should go in that. Do not create any other folders in this repository. 

Save Log:
Also, create an info.txt file in the MAIN_FOLDER detailing how much time each step took (1) For Transcription (2) From transcription to Written Edit Plan (3) From Edit plan to final cut pro or premiere pro file creation and (4) Final 4K render. Do not add any time to it while you wait for my input. Also save any more information you think might be important for the user to know in this info.txt file. Also, add the total time you took to create the final 4K video from the start. Do not add the waiting time for my input in it.

Feel free to use up to 10 agents (as and when required). The priority is to finish it as soon as possible.

Read the MEMORY.md file and include it into your prompt, it will give you some learnings from the past video editings.


When your REVIEW_OUTPUT_SOFTWARE output is done fully, clearly write “[OUTPUT COMPLETED]”, so I know it is over. 

My Availability:
I am not available to answer any of your questions, so make your best guess and proceed ahead. I would like to see the review output.
