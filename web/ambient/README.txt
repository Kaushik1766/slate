Drop a looping clip in here and it becomes the backdrop the dashboard's
glass panels refract over.

  - Use .mp4 or .webm. A GIF works too, but the same loop as video is a
    fraction of the size and far smoother.
  - Anything from a few seconds up works; it loops seamlessly.
  - More than one file? The dashboard picks one at random and rotates every
    six minutes.
  - The clip is shown only when nothing is playing. Album artwork is the more
    useful backdrop when there is any, so it takes over.

Tuning, in web/css/style.css:

  --clip-blur      how far out of focus the clip sits, default 7px
  --clip-opacity   how strongly it reads through the scrim

Files here are not committed to git.
