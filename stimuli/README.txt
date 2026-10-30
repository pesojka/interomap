The active experiment uses 16 IAPS images in four fixed blocks:
  threat: 1300, 1525, 2811, 6510
  integrity_disruption: 3030, 3213, 3261, 9042
  positive_1: 1463, 1710, 1920, 2071
  positive_2: 2347, 5628, 7325, 8540

Each block has its own subdirectory. CONFIG.trials in experiment.html defines
membership and stable stimulus identifiers. The task shuffles whole blocks and
images within each block once per session, then reuses that order for ratings.
The older img1.jpg through img4.jpg placeholders are no longer referenced.
