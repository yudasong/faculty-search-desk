// Synthetic posting with AJO's public field layout and external application routing.
export const ajoUrl = 'https://academicjobsonline.org/ajo/jobs/32272';
export const ethApply = 'https://ethz.ch/en/the-eth-zurich/working-teaching-and-research/faculty.html';
export const ajoHtml = (id = '32272') => `<html><title>ETH Zurich, Office for Faculty Affairs</title>
<h2>ETH Zurich, Office for Faculty Affairs</h2>
<div><b>Position ID:</b></div><div>ETH-AI [#${id}]</div>
<div class="nowrap"><b>Position Title:</b>&nbsp;</div><div>Professors of AI foundations</div>
<div><b>Position Location:</b></div><div>Heilbronn, Germany [<a href="https://maps.google.com/">map</a>]</div>
<div><b>Appl Deadline:</b></div><div>2026/09/30 23:59:59 (posted <span>2026/07/01</span>, listed until 2026/09/30)</div>
<div><b>Position Description:</b></div><div><a href="${ethApply}"><b>Apply</b></a></div>
<section><p>ETH Zurich seeks tenured faculty for a joint computer science and mathematics appointment in Heilbronn, Germany.</p>
<p>Required: CV, publication list, cover letter addressed to the university president, statements describing research, teaching and leadership, three key achievements, and proof of the highest degree.</p>
<p>The closing date is 30 September 2026.</p></section>
<b>We are not accepting applications through AcademicJobsOnline. Please use the external university application page.</b>
<a href="javascript:alert(1)">Unsafe link</a></html>`;
