const revealItems = document.querySelectorAll('.reveal');
const navLinks = document.querySelectorAll('.nav a[href^="#"]');
const trackedSections = document.querySelectorAll('main section[id]');
const directionsDialog = document.getElementById('directions-dialog');
const directionsOpenButtons = document.querySelectorAll('.js-directions-open');
const directionsCloseButton = document.getElementById('directions-close');
const mobileCta = document.querySelector('.mobile-cta');
const destinationQuery = encodeURIComponent("Uncle John's Flea Market, Cedar Lake, Indiana");
const googleDirectionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destinationQuery}`;
const appleDirectionsUrl = `https://maps.apple.com/?daddr=${destinationQuery}`;
const wazeDirectionsUrl = `https://www.waze.com/ul?q=${destinationQuery}&navigate=yes`;
const browserDirectionsUrl = `https://www.google.com/maps/search/?api=1&query=${destinationQuery}`;

const observer = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) {
        return;
      }

      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  },
  {
    threshold: 0.18,
  }
);

revealItems.forEach(item => observer.observe(item));

const navObserver = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) {
        return;
      }

      navLinks.forEach(link => {
        link.classList.toggle('is-active', link.getAttribute('href') === `#${entry.target.id}`);
      });
    });
  },
  {
    threshold: 0.45,
    rootMargin: '-20% 0px -45% 0px',
  }
);

trackedSections.forEach(section => navObserver.observe(section));

const updateMobileCta = () => {
  if (!mobileCta) {
    return;
  }

  const shouldShow = window.innerWidth <= 820 && window.scrollY > 680;
  document.body.classList.toggle('show-mobile-cta', shouldShow);
};

updateMobileCta();
window.addEventListener('scroll', updateMobileCta, { passive: true });
window.addEventListener('resize', updateMobileCta);

if (directionsDialog) {
  const googleLink = document.getElementById('directions-google');
  const appleLink = document.getElementById('directions-apple');
  const wazeLink = document.getElementById('directions-waze');
  const browserLink = document.getElementById('directions-browser');

  googleLink.href = googleDirectionsUrl;
  appleLink.href = appleDirectionsUrl;
  wazeLink.href = wazeDirectionsUrl;
  browserLink.href = browserDirectionsUrl;

  directionsOpenButtons.forEach(button => {
    button.addEventListener('click', () => {
      directionsDialog.showModal();
    });
  });

  directionsCloseButton.addEventListener('click', () => {
    directionsDialog.close();
  });

  directionsDialog.addEventListener('click', event => {
    const dialogBounds = directionsDialog.getBoundingClientRect();
    const clickedBackdrop =
      event.clientX < dialogBounds.left ||
      event.clientX > dialogBounds.right ||
      event.clientY < dialogBounds.top ||
      event.clientY > dialogBounds.bottom;

    if (clickedBackdrop) {
      directionsDialog.close();
    }
  });
}

document.getElementById('year').textContent = new Date().getFullYear();
