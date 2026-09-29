// Synthetic HTML shaped like academic job portals. Dates/materials below are
// test data, not a saved copy or assertion about a live hiring advertisement.
export const harvardHub = 'https://academicpositions.harvard.edu/postings/search?388%5B%5D=10';
export const harvardPosting = 'https://academicpositions.harvard.edu/postings/16840';
export const harvardPage2 = harvardHub + '&page=2';
export const harvardSchool = {
  id: 'harvard', name: 'Harvard University', shortName: 'Harvard', domain: 'harvard.edu',
  country: 'US', location: 'Cambridge, MA', considering: true, departments: ['CS'],
  sources: [{ department: 'CS', url: harvardHub }], notes: '', rankingNote: '', origin: 'Directory',
};
export const page = (title, body = '') => `<html><title>${title}</title><main><h1>${title}</h1><p>This is a synthetic academic hiring page for testing complete source reading, link discovery, departmental coverage, and extraction of job requirements. The page is intentionally long enough to distinguish it from a JavaScript shell.</p>${body}</main></html>`;
export const harvardPages = new Map([
  [harvardHub, page('Explore Academic Positions at Harvard', `
    <article><h2><a href="/postings/16840">Tenure-Track Professor in Computer Science</a></h2>
      <p>Faculty recruitment in computer science. Applicants should review the full announcement.</p>
      <a href="/postings/16840">View Details</a><a href="/bookmarks/16840">Bookmark</a></article>
    <article><h2><a href="/postings/90000">Postdoctoral Fellow in Computer Science</a></h2>
      <a href="/postings/90000">View Details</a></article>
    <article><h2><a href="/postings/90001">Fellow in Computer Science</a></h2>
      <a href="/postings/90001">View Details</a></article>
    <nav aria-label="pagination"><a href="?388%5B%5D=10&amp;page=2">Next</a></nav>
    <footer><a href="https://www.harvard.edu/privacy">Privacy</a></footer>`)],
  [harvardPosting, page('Tenure-Track Professor in Computer Science', `
    <p>Application deadline: December 1, 2026.</p><p>Submit a curriculum vitae, research statement,
    teaching statement, and three reference letters. Applications must include all required materials.</p>
    <a href="/postings/16840/pre_apply">Apply for this Job</a>`) ],
  [harvardPage2, page('Faculty positions, page 2', `<article><p>Interdisciplinary faculty opportunity.</p>
    <a href="/postings/16841">View Details</a></article>
    <nav><a href="?388%5B%5D=10">Previous</a><a href="?388%5B%5D=10">1</a></nav>
    <a href="?388%5B%5D=10&amp;page=2&amp;sort=title">Sort by position title</a>`) ],
  ['https://academicpositions.harvard.edu/postings/16841', page('Assistant Professor in Electrical Engineering', '<p>Full consideration: January 4, 2027. Required: curriculum vitae and a research statement.</p>')],
]);
