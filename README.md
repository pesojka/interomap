# Getting started

## Associated publication
Please cite:
Desmedt, O., Maurage, P., Leganes-Fonteneau, M., Billaux, P., & Billieux, J. (2025).
InteroMap: A Novel Tool to Map the Phenomenology of Bodily Sensations.

## Qualtrics

The following instructions will show you how to embed the InteroMap tool in a
Qualtrics survey. You need to repeat these steps for every question in which 
you wish to use InteroMap.

Here is an overview of the procedure:

1. Create a block containing the InteroMap tool preloaded with the _Female_ 
   persona.
2. Create another block with the InteroMap tool preloaded with the _Male_ 
   persona.
3. Create a question inviting the user to choose a persona.
4. Program your survey to receive data from the InteroMap tool and save it in 
   Qualtrics.

Note: If you use InteroMap multiple times in your survey (e.g. for different 
questions), you must choose a unique variable name which will hold the 
InteroMap data for each question separately. In the steps below, we use the 
variable `question1data` as an example to hold the data of the first question. 
If we have another question, say question 4, which uses InteroMap too, we must 
use another variable that we could name `question4data` for example.

### Steps

1. Click on one of the first questions of your survey (e.g., the welcome page). On the left, at 
the bottom of the _Edit question_ panel, click on **JavaScript**. Please don't insert this code
in a question/block that redirects participants to one or other branch. 

![Qualtrics - JavaScript](images/getting_started_qualtrics_7.png)

2. A new popup named _Edit Question JavaScript_ appears. Copy the following 
code inside the text area.

```javascript
Qualtrics.SurveyEngine.addOnReady(function()
{
 window.addEventListener('message', function(event) {
  if (event.data.event === "interomap_data") {
   Qualtrics.SurveyEngine.setEmbeddedData(event.data.variable, event.data.output);
  }
 })
});
```

Click on **Save**.

3. Add a new block to your survey by clicking on **Add Block** and to name it 
_InteroMap Female_.

![Qualtrics - Add Block](images/getting_started_qualtrics_1.png)

4. Inside this block, click on **Add new question** and select 
**Text / Graphic**

![Qualtrics - Add new question](images/getting_started_qualtrics_2.png)

5. A new question will appear inside the block. When you hover it, its 
background becomes gray. Click on it to enable the question toolbar.

![Qualtrics - Question hover](images/getting_started_qualtrics_3.png)

![Qualtrics - Question toolbar](images/getting_started_qualtrics_4.png)

6. Click on the **HTML View** tab. You should now be able to insert HTML code.

![Qualtrics - Question toolbar](images/getting_started_qualtrics_5.png)

7. Insert the following HTML code to embed the InteroMap tool with the 
pre-selected _female_ persona. Replace `<YOUR_VARIABLE>` in the code to
a variable name of your choosing. Use only alphanumeric ASCII characters
and always start with a letter. Do not use diacritics.

Examples of valid variable names: `control`, `happy`, `emotion1`,...

Replace `lang=en` with `lang=fr` if you wish to show the tool in French.
Only English and French are available currently.

```html
<iframe id="interomap_tool" src="https://interomap.github.io/interomap-dist/?lang=en&persona=female&variable=<YOUR_VARIABLE>" style="width: 100%; height: 100vh;" title="InteroMap Tool - Female"></iframe>
```

8. Click outside the text area to select the question panel. The InteroMap tool should now appear inside the question.

![Qualtrics - Select question](images/getting_started_qualtrics_6.png)


9. Repeat the steps 3 to 8 for another block named _InteroMap Male_. At step 7, 
replace `persona=female` with `persona=male` in the code.

10. To create the question inviting the user to choose a persona, create a new 
block and a new question inside it. Move this new block _before_ the ones 
containing the InteroMap tool. Design it to your liking. Here is an example :

![Qualtrics - Persona choice question](images/getting_started_qualtrics_9.png)

11. Open the block menu in the upper right corner and select 
**View block in survey flow**

![Qualtrics - Persona choice question](images/getting_started_qualtrics_10.png)

12. Create the following flow.

![Qualtrics - Survey flow persona choice](images/getting_started_qualtrics_11.png)

13. While you're in the _Survey flow_ page, at the bottom of the flow, click on 
**Add a New Element Here**. A new panel appears, click on **Embedded Data**.

![Qualtrics - Survey flow new element](images/getting_started_qualtrics_12.png)

14. Click on **Create New Field or Choose From Dropdown...** and type 
the variable name you chose at step 5 above. **Important**: the variable name
MUST be transcribed EXACTLY as in the code at step 7 (beware of the letter case).
Click on **Apply** to save your changes.

![Qualtrics - Survey flow apply](images/getting_started_qualtrics_13.png)

Repeat this step as many times as you have questions using InteroMap. For example, 
if you are using InteroMap in 3 questions, you should create 3 distinct variables.

15. To have a good format, we advise you to change the "style" of your Qualtrics.
Here are the steps: (1) Go to “Look and feel”; (2) Click on “Style”; (3) In custom CSS,
copy the following code:

```css
.SkinInner{
width: 100% !important;
}
``` 
16. To make sure that participants understand the task, we use detailed instructions
by illustrating the different steps that they should follow. We also use a control
task that requests them to color specific regions with specific colors.

:tada: You are done embedding the InteroMap tool in your survey.

**Questions?**
Please contact olivier.desmedt@uclouvain.be.

**How to visualize and analyze data?**
Another webpage exists to visualize individual and aggregated maps:
https://interomap.github.io/processing-tool/. The instruction page is available 
here: https://github.com/interomap/processing-tool.

**Important notes:**
NB1: Note that old versions of some web browsers may be incompatible with the
tool, although it is rare. 
NB2: Please pretest the tool and visualize the data before launching your experiment.
NB3: Because of Qualtrics limitations, there is a maximum drawing size. Although this
limit is difficult to reach and therefore rarely occurs, participants who make many 
drawings may eventually reach it, particularly if they draw outside the body area 
(these drawings are not visible but are still stored). If this occurs, ask 
participants to avoid drawing outside the body.
